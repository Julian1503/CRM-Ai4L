import { NextRequest, NextResponse } from 'next/server';
import { parseExcelBuffer } from '@/lib/excelParser';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const parsedData = parseExcelBuffer(buffer);

    return NextResponse.json(parsedData);
  } catch (error: any) {
    console.error('Spreadsheet parse API error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to parse spreadsheet file' },
      { status: 500 }
    );
  }
}
