import * as vscode from 'vscode'
import * as fs from 'fs'
import * as lw from '../../lw'
import { convertFilenameEncoding } from '../../utils/convertfilename'
import * as bibtexLogParser from './bibtexlogparser'
import * as biberLogParser from './biberlogparser'
import * as latexLogParser from './latexlog'

// Notice that 'Output written on filename.pdf' isn't output in draft mode.
// https://github.com/James-Yu/LaTeX-Workshop/issues/2893#issuecomment-936312853
const latexPattern = /^Output\swritten\son\s(.*)\s\(.*\)\.$/gm
const latexFatalPattern = /Fatal error occurred, no output PDF file produced!/gm

const latexmkPattern = /^Latexmk:\sapplying\srule/gm
const latexmkLog = /^Latexmk:\sapplying\srule/
const latexmkLogLatex = /^Latexmk:\sapplying\srule\s'(pdf|lua|xe)?latex'/
const latexmkUpToDate = /^Latexmk: All targets \(.*\) are up-to-date/m

const texifyPattern = /^running\s(pdf|lua|xe)?latex/gm
const texifyLog = /^running\s((pdf|lua|xe)?latex|miktex-bibtex)/
const texifyLogLatex = /^running\s(pdf|lua|xe)?latex/

const bibtexPattern = /^This is BibTeX, Version.*$/m
const biberPattern = /^INFO - This is Biber .*$/m

const DIAGNOSTIC_SEVERITY: { [key: string]: vscode.DiagnosticSeverity } = {
    'typesetting': vscode.DiagnosticSeverity.Information,
    'warning': vscode.DiagnosticSeverity.Warning,
    'error': vscode.DiagnosticSeverity.Error,
}

export type LogEntry = { type: string, file: string, text: string, line: number, errorPosText?: string }

const bibDiagnostics = vscode.languages.createDiagnosticCollection('BibTeX')
const biberDiagnostics = vscode.languages.createDiagnosticCollection('Biber')
const texDiagnostics = vscode.languages.createDiagnosticCollection('LaTeX')

/**
 * @param log The log message to parse.
 * @param rootFile The current root file.
 * @returns whether the current compilation is indeed a skipped one in latexmk.
 */
export function parse(log: string, rootFile?: string): boolean {
    let isLaTeXmkSkipped = false
    // Canonicalize line-endings
    log = log.replace(/(\r\n)|\r/g, '\n')

    if (log.match(bibtexPattern)) {
        const logs = bibtexLogParser.parse(log.match(latexmkPattern) ? trimLaTeXmkBibTeX(log) : log, rootFile)
        showCompilerDiagnostics(bibDiagnostics, logs, 'BibTeX')
    } else if (log.match(biberPattern)) {
        const logs = biberLogParser.parse(log.match(latexmkPattern) ? trimLaTeXmkBiber(log) : log, rootFile)
        showCompilerDiagnostics(biberDiagnostics, logs, 'Biber')
    }

    if (log.match(latexmkPattern)) {
        log = trimLaTeXmk(log)
    } else if (log.match(texifyPattern)) {
        log = trimTexify(log)
    }
    if (log.match(latexPattern) || log.match(latexFatalPattern)) {
        const logs = latexLogParser.parse(log, rootFile)
        showCompilerDiagnostics(texDiagnostics, logs, 'LaTeX')
    } else if (latexmkSkipped(log)) {
        isLaTeXmkSkipped = true
    }

    return isLaTeXmkSkipped
}

function trimLaTeXmk(log: string): string {
    return trimPattern(log, latexmkLogLatex, latexmkLog)
}

function trimLaTeXmkBibTeX(log: string): string {
    return trimPattern(log, bibtexPattern, latexmkLogLatex)
}

function trimLaTeXmkBiber(log: string): string {
    return trimPattern(log, biberPattern, latexmkLogLatex)
}

function trimTexify(log: string): string {
    return trimPattern(log, texifyLogLatex, texifyLog)
}


/**
 * Return the lines between the last occurrences of `beginPattern` and `endPattern`.
 * If `endPattern` is not found, the lines from the last occurrence of
 * `beginPattern` up to the end is returned.
 */
function trimPattern(log: string, beginPattern: RegExp, endPattern: RegExp): string {
    const lines = log.split('\n')
    let startLine = -1
    let finalLine = -1
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index]
        let result = line.match(beginPattern)
        if (result) {
            startLine = index
        }
        result = line.match(endPattern)
        if (result) {
            finalLine = index
        }
    }
    if (finalLine <= startLine) {
        return lines.slice(startLine).join('\n')
    } else {
        return lines.slice(startLine, finalLine).join('\n')
    }
}


function latexmkSkipped(log: string): boolean {
    if (log.match(latexmkUpToDate) && !log.match(latexmkPattern)) {
        showCompilerDiagnostics(texDiagnostics, latexLogParser.buildLog, 'LaTeX')
        showCompilerDiagnostics(bibDiagnostics, bibtexLogParser.buildLog, 'BibTeX')
        showCompilerDiagnostics(biberDiagnostics, biberLogParser.buildLog, 'Biber')
        return true
    }
    return false
}

function getErrorPosition(item: LogEntry): {start: number, end: number} | undefined {
    if (!item.errorPosText) {
        return
    }
    const content = lw.cacher.get(item.file)?.content
    if (!content) {
        return
    }
    // Try to find the errorPosText in the respective line of the document
    const lines = content.split('\n')
    if (lines.length >= item.line) {
        const line = lines[item.line-1]
        let pos = line.indexOf(item.errorPosText)
        if (pos >= 0) {
            pos += item.errorPosText.length
            // Find the length of the last word in the error.
            // This is the length of the error-range
            const len = item.errorPosText.length - item.errorPosText.lastIndexOf(' ') - 1
            if (len > 0) {
                return {start: pos - len, end: pos}
            }
        }
    }
    return
}

function showCompilerDiagnostics(compilerDiagnostics: vscode.DiagnosticCollection, buildLog: LogEntry[], source: string) {
    compilerDiagnostics.clear()
    const diagsCollection = Object.create(null) as { [key: string]: vscode.Diagnostic[] }
    for (const item of buildLog) {
        let startChar = 0
        let endChar = 65535
        // Try to compute a more precise position
        const preciseErrorPos = getErrorPosition(item)
        if (preciseErrorPos) {
            startChar = preciseErrorPos.start
            endChar = preciseErrorPos.end
        }

        const range = new vscode.Range(new vscode.Position(item.line - 1, startChar), new vscode.Position(item.line - 1, endChar))
        const diag = new vscode.Diagnostic(range, item.text, DIAGNOSTIC_SEVERITY[item.type])
        diag.source = source
        if (diagsCollection[item.file] === undefined) {
            diagsCollection[item.file] = []
        }
        diagsCollection[item.file].push(diag)
    }

    const configuration = vscode.workspace.getConfiguration('latex-workshop')
    const convEnc = configuration.get('message.convertFilenameEncoding') as boolean
    for (const file in diagsCollection) {
        let file1 = file
        if (!fs.existsSync(file1) && convEnc) {
            const f = convertFilenameEncoding(file1)
            if (f !== undefined) {
                file1 = f
            }
        }
        compilerDiagnostics.set(vscode.Uri.file(file1), diagsCollection[file])
    }
}
