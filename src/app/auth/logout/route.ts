import { NextResponse, type NextRequest } from 'next/server'

import { isSupabaseConfigured } from '@/lib/supabase/config'
import { createSupabaseServerClient } from '@/lib/supabase/server'

/**
 * Signs the current user out.
 *
 * POST only. A GET logout can be triggered by any third-party page embedding
 * `<img src="https://crm.example/auth/logout">`, which is a nuisance-grade CSRF.
 *
 * This route sits outside PUBLIC_PATHS on purpose, so proxy.ts still requires a
 * session to reach it.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isSupabaseConfigured()) {
    try {
      const supabase = await createSupabaseServerClient()
      // Clears the session server-side and expires the auth cookies via setAll.
      await supabase.auth.signOut()
    } catch {
      // Already signed out, or the auth service is unreachable. Either way the user
      // asked to leave — send them to /login rather than showing an error.
    }
  }

  const response = NextResponse.redirect(new URL('/login', request.nextUrl.origin), {
    // 303 forces the follow-up to be a GET, which is what a redirect after POST needs.
    status: 303,
  })
  response.headers.set('Cache-Control', 'private, no-store')

  return response
}
