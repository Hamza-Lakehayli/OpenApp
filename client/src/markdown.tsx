/**
 * A small, safe markdown renderer for chat text — no external dependencies.
 * Supports what agent output actually uses: fenced code blocks, inline code,
 * bold/italic, headings, lists, tables, and blockquotes — rendered as React
 * nodes, never as raw HTML.
 */
import { Fragment, type ReactNode } from "react"

type CodeFence = { lang: string; code: string }

function parseBlocks(text: string): (CodeFence | { md: string })[] {
  const parts: (CodeFence | { md: string })[] = []
  const fence = /```(\w*)\n?([\s\S]*?)(?:```|$)/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = fence.exec(text))) {
    if (match.index > last) parts.push({ md: text.slice(last, match.index) })
    parts.push({ lang: match[1] || "", code: match[2].replace(/\n$/, "") })
    last = fence.lastIndex
  }
  if (last < text.length) parts.push({ md: text.slice(last) })
  return parts
}

/** Absolute local paths (drive letters or rooted) — agents write these as
 *  download links for files they produced. Relative paths stay plain text:
 *  without a workspace they're ambiguous, and the agent usually also states
 *  the full path elsewhere. */
const FILE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/

function inline(
  text: string,
  keyPrefix: string,
  onFile?: (path: string) => void,
): ReactNode[] {
  const nodes: ReactNode[] = []
  // code spans, bold, and links
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(https?:\/\/[^\s)<>]+)/g
  let last = 0
  let match: RegExpExecArray | null
  let i = 0
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const [full] = match
    if (full.startsWith("`")) {
      nodes.push(<code key={`${keyPrefix}-${i}`}>{full.slice(1, -1)}</code>)
    } else if (full.startsWith("**")) {
      nodes.push(<strong key={`${keyPrefix}-${i}`}>{full.slice(2, -2)}</strong>)
    } else if (full.startsWith("*")) {
      nodes.push(<em key={`${keyPrefix}-${i}`}>{full.slice(1, -1)}</em>)
    } else if (FILE_PATH.test(full)) {
      const name = full.split(/[\\/]/).pop() || full
      nodes.push(
        <button
          key={`${keyPrefix}-${i}`}
          className="md-file-link"
          title={full}
          onClick={() => onFile?.(full)}
        >
          {name}
        </button>,
      )
    } else {
      nodes.push(
        <a key={`${keyPrefix}-${i}`} href={full} target="_blank" rel="noreferrer">
          {full}
        </a>,
      )
    }
    last = pattern.lastIndex
    i++
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function renderMd(
  md: string,
  keyPrefix: string,
  onFile?: (path: string) => void,
): ReactNode[] {
  const lines = md.split("\n")
  const out: ReactNode[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let table: { head: string[]; rows: string[][] } | null = null

  // `| a | b |` — trim the fence pipes, split the rest
  const cells = (line: string) => {
    let t = line.trim()
    if (t.startsWith("|")) t = t.slice(1)
    if (t.endsWith("|")) t = t.slice(0, -1)
    return t.split("|").map((c) => c.trim())
  }
  const isSep = (line: string) => {
    const cs = cells(line)
    return cs.length > 0 && cs.every((c) => /^:?-{2,}:?$/.test(c))
  }
  const isRow = (line: string) => /^\s*\|/.test(line)

  const flush = () => {
    if (list) {
      const items = list.items.map((item, i) => <li key={i}>{inline(item, `${keyPrefix}-li-${i}`)}</li>)
      out.push(
        list.ordered ? (
          <ol key={`${keyPrefix}-ul-${out.length}`}>{items}</ol>
        ) : (
          <ul key={`${keyPrefix}-ul-${out.length}`}>{items}</ul>
        ),
      )
      list = null
    }
    if (table) {
      const cell = (c: string, tag: "th" | "td", k: string) => {
        const content = inline(c, k, onFile)
        return tag === "th" ? <th key={k}>{content}</th> : <td key={k}>{content}</td>
      }
      out.push(
        <div key={`${keyPrefix}-tbl-${out.length}`} className="md-table-wrap">
          <table>
            <thead>
              <tr>{table.head.map((c, j) => cell(c, "th", `${keyPrefix}-th-${j}`))}</tr>
            </thead>
            <tbody>
              {table.rows.map((r, ri) => (
                <tr key={ri}>{r.map((c, j) => cell(c, "td", `${keyPrefix}-td-${ri}-${j}`))}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      table = null
    }
  }

  lines.forEach((line, i) => {
    const key = `${keyPrefix}-${i}`
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    const quote = /^>\s?(.*)$/.exec(line)

    if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
      // table starts: header row directly above a separator row
      flush()
      table = { head: cells(line), rows: [] }
    } else if (table && isSep(line)) {
      // separator(s) after the header are structure, not content
    } else if (table && isRow(line)) {
      table.rows.push(cells(line))
    } else if (heading) {
      flush()
      const level = heading[1].length
      const Tag = (["h1", "h2", "h3", "h4"] as const)[level - 1]
      out.push(<Tag key={key}>{inline(heading[2], key)}</Tag>)
    } else if (bullet) {
      if (!list || list.ordered) {
        flush()
        list = { ordered: false, items: [] }
      }
      list.items.push(bullet[1])
    } else if (numbered) {
      if (!list || !list.ordered) {
        flush()
        list = { ordered: true, items: [] }
      }
      list.items.push(numbered[1])
    } else if (quote) {
      flush()
      out.push(
        <blockquote key={key}>{inline(quote[1], key)}</blockquote>,
      )
    } else if (line.trim() === "") {
      flush()
    } else {
      flush()
      out.push(<p key={key}>{inline(line, key)}</p>)
    }
  })
  flush()
  return out
}

export function Markdown({
  text,
  onFile,
}: {
  text: string
  onFile?: (path: string) => void
}) {
  const blocks = parseBlocks(text)
  return (
    <div className="md">
      {blocks.map((block, i) =>
        "code" in block ? (
          <pre key={i} className="code-block">
            {block.lang && <span className="code-lang">{block.lang}</span>}
            <code>{block.code}</code>
          </pre>
        ) : (
          <Fragment key={i}>{renderMd(block.md, `md-${i}`, onFile)}</Fragment>
        ),
      )}
    </div>
  )
}
