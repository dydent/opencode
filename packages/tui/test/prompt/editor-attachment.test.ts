import { expect, test } from "bun:test"
import { editorAttachment } from "../../src/component/prompt/editor-attachment"
import type { EditorSelection } from "../../src/context/editor"

const selection = {
  filePath: "/workspace/Main.kt",
  ranges: [
    {
      text: 'println("unsaved λ")',
      selection: { start: { line: 12, character: 2 }, end: { line: 13, character: 0 } },
    },
  ],
} satisfies EditorSelection

test("selection attachments preserve exact unsaved UTF-8 text and one-based source positions", () => {
  const input = structuredClone(selection)
  const file = editorAttachment("selection", input)
  input.ranges[0].text = "later edit"
  expect(file.name).toBe("Main.kt#13:3-14:1")
  expect(Buffer.from(file.uri.split(",")[1], "base64").toString("utf8")).toBe(
    'File: /workspace/Main.kt\nSelection: 13:3-14:1 (end exclusive)\n\nprintln("unsaved λ")',
  )
})

test("current-file attachments point at the entire saved file and encode spaces", () => {
  const file = editorAttachment("thisfile", { ...selection, filePath: "/workspace/with space/Main.kt" })
  expect(file.uri).toBe("file:///workspace/with%20space/Main.kt")
  expect(file.description).toBe("Current IDE file (saved contents)")
  expect(file.uri).not.toContain("start=")
})

test("missing and non-absolute IDE paths cannot attach an unrelated local file", () => {
  expect(() => editorAttachment("thisfile", undefined)).toThrow("No current IDE file")
  expect(() => editorAttachment("thisfile", { ...selection, filePath: "Main.kt" })).toThrow("No current IDE file")
})

test("a deselected file remains available but cannot become a selection snapshot", () => {
  const input = { ...selection, ranges: [{ ...selection.ranges[0], text: "" }] }
  expect(editorAttachment("thisfile", input).uri).toBe("file:///workspace/Main.kt")
  expect(() => editorAttachment("selection", input)).toThrow("No code is selected")
})

test("selection limits count UTF-8 bytes including source metadata", () => {
  const input = { ...selection, ranges: [{ ...selection.ranges[0], text: "λ".repeat(10 * 1024 * 1024) }] }
  expect(() => editorAttachment("selection", input)).toThrow("20 MiB")
})

test("multiple selection ranges retain their own source positions", () => {
  const file = editorAttachment("selection", {
    ...selection,
    ranges: [
      ...selection.ranges,
      {
        text: "second range",
        selection: { start: { line: 20, character: 0 }, end: { line: 20, character: 12 } },
      },
    ],
  })
  const content = Buffer.from(file.uri.split(",")[1], "base64").toString("utf8")
  expect(content).toContain("Selection: 13:3-14:1")
  expect(content).toContain("Selection: 21:1-21:13 (end exclusive)\n\nsecond range")
})
