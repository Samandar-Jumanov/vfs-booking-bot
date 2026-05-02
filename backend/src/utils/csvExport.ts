import { Transform, TransformCallback } from 'stream';

type Row = Record<string, unknown>;

function escapeCell(value: unknown): string {
  const str = value == null ? '' : String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function buildCsvLine(row: Row, headers: string[]): string {
  return headers.map((h) => escapeCell(row[h])).join(',');
}

/** A Transform stream that converts Row objects to CSV lines. */
export class CsvTransform extends Transform {
  private headers: string[];
  private headerWritten = false;

  constructor(headers: string[]) {
    super({ objectMode: true });
    this.headers = headers;
  }

  _transform(row: Row, _encoding: string, callback: TransformCallback): void {
    if (!this.headerWritten) {
      this.push(this.headers.join(',') + '\n');
      this.headerWritten = true;
    }
    this.push(buildCsvLine(row, this.headers) + '\n');
    callback();
  }
}
