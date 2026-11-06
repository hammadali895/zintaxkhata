# Digital Khata — local setup

1. Install Node.js 22.5 or newer.
2. In this folder, run `npm start`.
3. Open `http://localhost:3000` and choose **Create an account** to set a username and password.
4. On your phone, join the same Wi-Fi and open the **Mobile (same Wi-Fi)** address printed by the server. Sign in with the same username and password.

The app and API are served by the same local server. Account passwords are stored as salted hashes; khata records are kept in `data/khata.sqlite`. Keep the server running while using the app on your phone. If Windows Firewall prompts you, allow Node.js on your private network. Do not expose this development server directly to the public internet.

To keep a database somewhere else, set `KHATA_DB_PATH` before starting the server.

## Deploy to Vercel with Supabase

1. Create a Supabase project and run `supabase/schema.sql` in its SQL Editor. For an existing installation, run `supabase/migrations/20261106_business_settings.sql` to enable saved receipt branding.
2. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as Vercel project environment variables. Find them in the Supabase project's API settings. Keep the service role key private; never commit it or put it in frontend code.
3. Import this project from a private GitHub repository in Vercel and deploy. Vercel serves the static app and the `/api` serverless function.
4. Open the Vercel HTTPS URL and create a username/password account. Use **Settings** to set the business name and optional logo shown on new transaction and sale receipts.

Vercel's serverless function uses Supabase; it does not use the local SQLite database. The local `npm start` server continues to use SQLite.
