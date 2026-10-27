import { createClient, type SupabaseClient } from '@supabase/supabase-js';

declare global {
  interface Window {
    __JOINTCARE_RUNTIME__?: { supabaseUrl?: string; publishableKey?: string };
  }
}

const runtime = typeof window === 'undefined' ? undefined : window.__JOINTCARE_RUNTIME__;
const url = import.meta.env.PUBLIC_SUPABASE_URL?.trim() || runtime?.supabaseUrl?.trim();
const key = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() || runtime?.publishableKey?.trim();

export const supabaseConfigured = Boolean(url && key);
export const supabase: SupabaseClient | null = supabaseConfigured
  ? createClient(url!, key!, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
      },
    })
  : null;

export const supabaseSetupHint = 'Configure PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_PUBLISHABLE_KEY in the project runtime environment.';
