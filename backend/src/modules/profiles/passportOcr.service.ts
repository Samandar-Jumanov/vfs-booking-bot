import sharp from 'sharp';
import Tesseract from 'tesseract.js';

export interface ExtractedPassportData {
  fullName?: string;
  passportNumber?: string;
  dob?: string;
  passportExpiry?: string;
  nationality?: string;
  gender?: 'MALE' | 'FEMALE' | 'OTHER';
}

export interface PassportOcrResult {
  extracted: boolean;
  confidence?: number;
  mrz?: string[];
  data?: ExtractedPassportData;
}

type MrzParseResult = {
  valid: boolean;
  fields: Record<string, string | null | undefined>;
  documentNumber: string | null;
};

export async function extractPassportFromImage(buffer: Buffer): Promise<PassportOcrResult> {
  const cropped = await cropMrzRegion(buffer);
  const { data } = await Tesseract.recognize(cropped, 'eng');
  return parsePassportOcrText(data.text, data.confidence);
}

async function cropMrzRegion(buffer: Buffer) {
  const image = sharp(buffer);
  const metadata = await image.metadata();
  const width = metadata.width;
  const height = metadata.height;

  if (!width || !height) {
    return buffer;
  }

  const cropHeight = Math.max(1, Math.floor(height * 0.4));
  return image
    .extract({ left: 0, top: height - cropHeight, width, height: cropHeight })
    .grayscale()
    .normalize()
    .sharpen()
    .png()
    .toBuffer();
}

export async function parsePassportOcrText(text: string, confidence?: number): Promise<PassportOcrResult> {
  const mrz = extractMrzLines(text);
  if (!mrz) {
    return { extracted: false, confidence: normalizeConfidence(confidence) };
  }

  try {
    const { parse } = await loadMrzParser();
    const parsed = parse(mrz, { autocorrect: true }) as MrzParseResult;

    if (!parsed.documentNumber || !parsed.fields.birthDate || !parsed.fields.expirationDate) {
      const fallback = parseTd3Fallback(mrz);
      return fallback
        ? { extracted: true, confidence: normalizeConfidence(confidence), mrz, data: fallback }
        : { extracted: false, confidence: normalizeConfidence(confidence), mrz };
    }

    return {
      extracted: true,
      confidence: normalizeConfidence(confidence),
      mrz,
      data: mapMrzFields(parsed, mrz),
    };
  } catch {
    const fallback = parseTd3Fallback(mrz);
    return fallback
      ? { extracted: true, confidence: normalizeConfidence(confidence), mrz, data: fallback }
      : { extracted: false, confidence: normalizeConfidence(confidence), mrz };
  }
}

async function loadMrzParser(): Promise<{ parse: (lines: string[], options: { autocorrect: boolean }) => unknown }> {
  return Function('return import("mrz")')();
}

export function extractMrzLines(text: string): string[] | null {
  const candidates = text
    .split(/\r?\n/)
    .map(cleanOcrLine)
    .filter((line) => line.length >= 28);

  for (let i = 0; i < candidates.length - 1; i += 1) {
    const first = normalizeMrzLength(candidates[i], 44);
    const second = normalizeMrzLength(candidates[i + 1], 44);
    if (first && second && first.startsWith('P<')) {
      return [first, second];
    }
  }

  for (let i = 0; i < candidates.length - 2; i += 1) {
    const lines = [
      normalizeMrzLength(candidates[i], 30),
      normalizeMrzLength(candidates[i + 1], 30),
      normalizeMrzLength(candidates[i + 2], 30),
    ];
    if (lines.every(Boolean)) {
      return lines as string[];
    }
  }

  return null;
}

function cleanOcrLine(line: string) {
  return line
    .toUpperCase()
    .replace(/[«‹{[\(]/g, '<')
    .replace(/[»›}\]\)]/g, '<')
    .replace(/\s/g, '')
    .replace(/[^A-Z0-9<]/g, '')
    .replace(/L{3,}$/g, (match) => '<'.repeat(match.length));
}

function normalizeMrzLength(line: string, length: number) {
  if (line.length === length) return line;
  if (line.length > length) return line.slice(0, length);
  if (line.length >= length - 2) return line.padEnd(length, '<');
  return null;
}

function mapMrzFields(parsed: MrzParseResult, mrz: string[]): ExtractedPassportData {
  const fields = parsed.fields;
  const firstName = fields.firstName?.replace(/</g, ' ').trim();
  const lastName = fields.lastName?.replace(/</g, ' ').trim();
  const fullName = [firstName, lastName].filter(Boolean).join(' ');
  const rawNationality = mrz.length === 2 ? mrz[1].slice(10, 13).replace(/</g, '').trim() : undefined;

  return {
    fullName: fullName || undefined,
    passportNumber: parsed.documentNumber ?? undefined,
    dob: fields.birthDate ? mrzDateToIso(fields.birthDate, 'birth') : undefined,
    passportExpiry: fields.expirationDate ? mrzDateToIso(fields.expirationDate, 'expiry') : undefined,
    nationality: fields.nationality ?? rawNationality ?? undefined,
    gender: mapSex(fields.sex),
  };
}

function parseTd3Fallback(mrz: string[]): ExtractedPassportData | null {
  if (mrz.length !== 2 || !mrz[0].startsWith('P<') || mrz[0].length !== 44 || mrz[1].length !== 44) {
    return null;
  }

  const [nameLine, dataLine] = mrz;
  const [rawLastName = '', rawFirstNames = ''] = nameLine.slice(5).split('<<');
  const passportNumber = dataLine.slice(0, 9).replace(/</g, '').trim();
  const nationality = dataLine.slice(10, 13).replace(/</g, '').trim();
  const birthDate = dataLine.slice(13, 19);
  const sex = dataLine.slice(20, 21);
  const expirationDate = dataLine.slice(21, 27);

  if (!passportNumber || !/^\d{6}$/.test(birthDate) || !/^\d{6}$/.test(expirationDate)) {
    return null;
  }

  const firstName = rawFirstNames.replace(/</g, ' ').trim();
  const lastName = rawLastName.replace(/</g, ' ').trim();

  return {
    fullName: [firstName, lastName].filter(Boolean).join(' ') || undefined,
    passportNumber,
    dob: mrzDateToIso(birthDate, 'birth'),
    passportExpiry: mrzDateToIso(expirationDate, 'expiry'),
    nationality: nationality || undefined,
    gender: sex === 'M' ? 'MALE' : sex === 'F' ? 'FEMALE' : 'OTHER',
  };
}

function mrzDateToIso(value: string, mode: 'birth' | 'expiry') {
  const yy = Number(value.slice(0, 2));
  const month = value.slice(2, 4);
  const day = value.slice(4, 6);
  let year = 2000 + yy;

  if (mode === 'birth') {
    const date = new Date(Date.UTC(year, Number(month) - 1, Number(day)));
    if (date.getTime() > Date.now()) year -= 100;
  }

  return `${year.toString().padStart(4, '0')}-${month}-${day}`;
}

function mapSex(value: string | null | undefined): 'MALE' | 'FEMALE' | 'OTHER' | undefined {
  if (value === 'male') return 'MALE';
  if (value === 'female') return 'FEMALE';
  if (value === 'nonspecified') return 'OTHER';
  return undefined;
}

function normalizeConfidence(confidence?: number) {
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) return undefined;
  return Math.round(confidence);
}
