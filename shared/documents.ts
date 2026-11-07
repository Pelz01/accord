export type ParsedDocument = {
  text: string;
  pages: number;
  source: 'pdf-text' | 'ocr';
  mediaType: 'application/pdf' | 'image/png' | 'image/jpeg';
  previewBase64: string;
  previewType: 'image/png' | 'image/jpeg';
};
export type StoredDocument = ParsedDocument & {
  id: string;
  name: string;
  documentHash: string;
  expiresAt: string;
};
