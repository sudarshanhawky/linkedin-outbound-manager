# Supabase setup (shared backend)

The app uses Supabase as the shared database so you and your colleagues see the same contacts. No sign-in.

## 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and sign in.
2. **New project** → pick org, name (e.g. `linkedin-outbound`), database password, region → Create.

## 2. Create the table and RLS

1. In the Supabase dashboard, open **SQL Editor**.
2. **New query** → paste the contents of `supabase-schema.sql` (in this repo) → **Run**.

That creates the `contacts` table and policies so the app (anon key) can read/write.

## 3. Get your keys

1. In Supabase: **Project Settings** (gear) → **API**.
2. Copy:
   - **Project URL**
   - **anon public** (under "Project API keys").

## 4. Add env vars in Vercel

1. Vercel → your project → **Settings** → **Environment Variables**.
2. Add:
   - `NEXT_PUBLIC_SUPABASE_URL` = your Project URL  
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = your anon public key  
3. Apply to **Production** (and Preview if you use it).
4. **Redeploy** the app so the new env vars are used.

After that, the app will load and save contacts to Supabase. Everyone using the same Vercel URL shares the same data; changes from anyone show for everyone (refresh to see others’ edits, or we can add real-time later).
