# Serwer skrótów meczów (Chemik Leagues)

Osobna usługa na Railway. Worker ligi zleca skrót po meczu, serwer pobiera VOD z Twitcha,
wybiera akcje (kliknięcia „🎬 Clip!” + skoki głośności + ocena Gemini), skleja skrót 16:9 i 9:16
i odsyła pliki do Workera (Cloudflare R2). Skrót czeka na akceptację admina.

## Zmienne (Railway → Variables)
- `WORKER_SECRET` — ta sama wartość co `DISCORD_WEBHOOK_SECRET` w Workerach
- `GEMINI_API_KEY` — klucz Gemini (ten sam co w bocie)

## Sprawdzenie
`GET https://<adres-usługi>/health` → `{"ok":true,"queue":0,"current":null,"gemini":true}`
