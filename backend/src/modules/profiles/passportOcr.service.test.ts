import { extractMrzLines, parsePassportOcrText } from './passportOcr.service';

describe('passportOcr.service', () => {
  it('extracts and normalizes TD3 passport MRZ lines from OCR text', () => {
    expect(
      extractMrzLines(`
        noisy header
        P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<
        L898902C36UTO7408122F1204159ZE184226B<<<<<10
      `),
    ).toEqual([
      'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<',
      'L898902C36UTO7408122F1204159ZE184226B<<<<<10',
    ]);
  });

  it('parses valid passport MRZ data into profile fields', async () => {
    const result = await parsePassportOcrText(
      `
        P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<
        L898902C36UTO7408122F1204159ZE184226B<<<<<10
      `,
      87.4,
    );

    expect(result).toMatchObject({
      extracted: true,
      confidence: 87,
      mrz: [
        'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<',
        'L898902C36UTO7408122F1204159ZE184226B<<<<<10',
      ],
      data: {
        fullName: 'ANNA MARIA ERIKSSON',
        passportNumber: 'L898902C3',
        dob: '1974-08-12',
        passportExpiry: '2012-04-15',
        nationality: 'UTO',
        gender: 'FEMALE',
      },
    });
  });

  it('returns extracted false when OCR text has no MRZ', async () => {
    await expect(parsePassportOcrText('not a passport', 20)).resolves.toEqual({
      extracted: false,
      confidence: 20,
    });
  });
});
