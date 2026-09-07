# Qamar Baileys Connector

Low-cost experimental WhatsApp Linked Device connector for Qamar.

## Pairing flow

1. Deploy this folder as a separate Render Node web service.
2. Set `PAIRING_API_KEY`.
3. POST `/pair` with `{ "phone": "234XXXXXXXXXX" }` and `x-api-key` header.
4. Enter the returned code in WhatsApp: **Linked Devices → Link with phone number**.
5. `/status` confirms the linked session.

## Important

This uses the unofficial Baileys WhatsApp Web protocol, not the official Meta WhatsApp Cloud API. It is experimental and may break if WhatsApp changes its protocol. Baileys documents pairing-code authentication, but recent upstream issue reports show that pairing-code reliability can vary by WhatsApp/server conditions.

The current connector uses a local auth directory for the first test. Render's free filesystem is not durable, so persistent session storage should be moved to durable storage (for example Supabase-backed auth state) before production use.
