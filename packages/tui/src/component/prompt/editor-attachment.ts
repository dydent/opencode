import path from "node:path"
import { pathToFileURL } from "node:url"
import type { PromptInput } from "@opencode/schema"
import type { EditorSelection } from "../../context/editor"
import { MAX_LOCAL_ATTACHMENT_BYTES } from "./local-attachment"

export function editorAttachment(
  kind: "selection" | "thisfile",
  selection: EditorSelection | undefined,
): PromptInput.FileAttachment {
  if (!selection?.filePath || !path.isAbsolute(selection.filePath)) throw new Error("No current IDE file is available")
  if (kind === "thisfile") {
    return {
      uri: pathToFileURL(selection.filePath).href,
      name: path.basename(selection.filePath),
      description: "Current IDE file (saved contents)",
      mention: { start: 0, end: 0, text: "" },
    }
  }

  const ranges = selection.ranges.filter((range) => range.text.length > 0)
  if (ranges.length === 0) throw new Error("No code is selected in the IDE")
  const labels = ranges.map((range) => {
    const start = range.selection.start
    const end = range.selection.end
    return `${start.line + 1}:${start.character + 1}-${end.line + 1}:${end.character + 1}`
  })
  const content = ranges
    .map((range, index) => `File: ${selection.filePath}\nSelection: ${labels[index]} (end exclusive)\n\n${range.text}`)
    .join("\n\n")
  if (Buffer.byteLength(content) > MAX_LOCAL_ATTACHMENT_BYTES)
    throw new Error("IDE selection exceeds the 20 MiB attachment limit")
  return {
    uri: `data:text/plain;base64,${Buffer.from(content).toString("base64")}`,
    name: `${path.basename(selection.filePath)}#${labels.join(",")}`,
    description: "IDE selection snapshot",
    mention: { start: 0, end: 0, text: "" },
  }
}
