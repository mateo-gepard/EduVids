declare module 'pdf-parse' {
  interface PDFData {
    numpages: number;
    numrender: number;
    info: Record<string, any>;
    metadata: Record<string, any>;
    text: string;
    version: string;
  }

  function pdf(dataBuffer: Buffer | ArrayBuffer): Promise<PDFData>;
  export = pdf;
}
