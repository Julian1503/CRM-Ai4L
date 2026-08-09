/**
 * Login form state.
 *
 * Deliberately NOT in actions.ts. A `'use server'` module may only export async
 * functions — exporting a plain object from one makes the entire module fail to
 * evaluate at runtime with "A 'use server' file can only export async functions",
 * taking the login page down with it.
 *
 * The build does not catch this, and neither does Jest, which imports the module
 * directly without the Server Actions transform. It only surfaces when the page is
 * actually rendered.
 */
export type LoginState = {
  error: string | null
  fieldErrors?: { email?: string; password?: string }
}

export const INITIAL_LOGIN_STATE: LoginState = { error: null }
