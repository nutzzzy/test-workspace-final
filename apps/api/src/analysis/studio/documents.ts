import { BadRequestException } from "@nestjs/common";

/** PRDs and other business documents: only their text is kept and analysed. */

export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;
export const MAX_DOCUMENT_CHARS = 400_000;

const TEXT_TYPES = /\.(md|markdown|txt|text)$/i;

/** Plain text of an uploaded .md/.txt/.pdf/.docx file. */
export async function extractDocumentText(file: { originalname: string; mimetype: string; buffer: Buffer; size: number }): Promise<string> {
  if (file.size > MAX_DOCUMENT_BYTES) throw new BadRequestException("The document is too large (max 15 MB)");
  const name = file.originalname.toLowerCase();
  let text: string;
  try {
    if (TEXT_TYPES.test(name) || file.mimetype.startsWith("text/")) {
      text = file.buffer.toString("utf8");
    } else if (name.endsWith(".pdf") || file.mimetype === "application/pdf") {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(file.buffer));
      const result = await extractText(pdf, { mergePages: false });
      text = (Array.isArray(result.text) ? result.text : [result.text]).join("\n\n");
    } else if (name.endsWith(".docx") || file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      const mammoth = await import("mammoth");
      text = (await mammoth.extractRawText({ buffer: file.buffer })).value;
    } else {
      throw new BadRequestException("Supported documents: .md, .txt, .pdf, .docx");
    }
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException("The document could not be read");
  }
  return cleanDocumentText(text);
}

export function cleanDocumentText(text: string): string {
  const cleaned = text
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  if (!cleaned) throw new BadRequestException("The document has no readable text");
  if (cleaned.length > MAX_DOCUMENT_CHARS) throw new BadRequestException("The document text is too long (max 400,000 characters)");
  return cleaned;
}
