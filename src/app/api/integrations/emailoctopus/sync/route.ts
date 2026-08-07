import { NextRequest, NextResponse } from 'next/server';
import { syncContactToEmailOctopus } from '@/lib/emailOctopus';

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json();

    if (!payload || !payload.apiKey || !payload.listId || !Array.isArray(payload.contacts)) {
      return NextResponse.json({ error: 'Missing required sync parameters' }, { status: 400 });
    }

    const { apiKey, listId, contacts } = payload;
    const errors: Array<{ email: string; error: string }> = [];
    let syncedCount = 0;

    // Process contacts list
    for (const c of contacts) {
      try {
        const status = c.subscribedToNewsletter ? 'SUBSCRIBED' : 'UNSUBSCRIBED';
        await syncContactToEmailOctopus(
          apiKey,
          listId,
          c.email,
          c.firstName || '',
          c.lastName || '',
          status
        );
        syncedCount++;
      } catch (err: any) {
        console.error(`Failed to sync contact ${c.email}:`, err);
        errors.push({ email: c.email, error: err.message || 'Unknown error' });
      }
    }

    return NextResponse.json({
      success: true,
      syncedCount,
      errorsCount: errors.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error: any) {
    console.error('EmailOctopus Sync Error:', error);
    return NextResponse.json(
      { error: error.message || 'Sync operation failed' },
      { status: 500 }
    );
  }
}
