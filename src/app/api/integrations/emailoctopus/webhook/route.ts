import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/lib/supabaseClient';

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json();

    if (!payload || !payload.event || !payload.contact || !payload.contact.email_address) {
      return NextResponse.json({ error: 'Invalid webhook payload' }, { status: 400 });
    }

    const { event, contact } = payload;
    const email = contact.email_address;

    let isSubscribed = false;
    if (event === 'contact.subscribed') {
      isSubscribed = true;
    } else if (event === 'contact.unsubscribed') {
      isSubscribed = false;
    } else {
      return NextResponse.json({ status: 'ignored', message: `Event type ${event} ignored` });
    }

    const db = getSupabaseClient();
    const { error } = await db
      .from('contacts')
      .update({ subscribed_to_newsletter: isSubscribed })
      .eq('email', email);

    if (error) {
      throw error;
    }

    return NextResponse.json({ success: true, email, isSubscribed });
  } catch (error) {
    console.error('EmailOctopus Webhook Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Webhook processing failed' },
      { status: 500 }
    );
  }
}
