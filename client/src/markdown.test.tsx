import { describe, expect, it } from "vitest"
import { renderToString } from "react-dom/server"
import { Markdown } from "./markdown"

const render = (text: string) => renderToString(<Markdown text={text} />)

describe("markdown tables", () => {
  it("renders a header + separator + body rows as a table", () => {
    const html = render("| Observation | Data |\n|---|---|\n| Failed | 32s |\n| OK | 2.5s |")
    expect(html).toContain("<table")
    expect(html).toContain("<th>Observation</th>")
    expect(html).toContain("<td>Failed</td>")
    expect(html).toContain("<td>2.5s</td>")
    expect(html).not.toContain("|---|")
  })

  it("renders inline code and bold inside cells", () => {
    const html = render("| Cmd | Note |\n|---|---|\n| `npm x` | **fast** |")
    expect(html).toContain("<code>npm x</code>")
    expect(html).toContain("<strong>fast</strong>")
  })

  it("a pipe line without a separator row stays a paragraph", () => {
    const html = render("| just | text |")
    expect(html).not.toContain("<table")
    expect(html).toContain("just")
  })

  it("a table ends and a following list renders separately", () => {
    const html = render("| a | b |\n|---|---|\n| 1 | 2 |\n\n- item one")
    expect(html).toContain("<table")
    expect(html).toContain("<li>item one</li>")
  })

  it("separator rows never leak in as content", () => {
    const html = render("| h |\n|---|\n|---|")
    expect((html.match(/<td>/g) ?? []).length).toBe(0)
  })
})
