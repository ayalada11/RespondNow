# RespondNow

An email agent you CC in your email threads to book meetings, share availability, and follow up with leads automatically.

## How It Works

1. **CC the agent** in any email to a lead/prospect
2. The agent **replies with your availability** from Google Calendar
3. When the lead picks a time, the agent **books the meeting** and sends calendar invites
4. If the lead doesn't respond, the agent **follows up 3 times** automatically
5. After 3 follow-ups with no response, it notifies you and stops

## Deploy to Railway

### 1. Create a Railway project

- Go to [railway.app](https://railway.app) and create a new project
- Connect your GitHub repo (`ayalada11/RespondNow`)
- Railway auto-detects the `railway.json` config and deploys

### 2. Set environment variables

In Railway dashboard > Variables, add:

| Variable | Description |
|---|---|
| `AGENT_EMAIL` | The email address for your agent (e.g. `assistant@yourdomain.com`) |
| `GEMINI_API_KEY` | Google Gemini API key ([free at aistudio.google.com](https://aistudio.google.com/apikey)) |
| `GOOGLE_CLIENT_ID` | Google OAuth2 client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth2 client secret |
| `GOOGLE_REFRESH_TOKEN` | Get this by running the OAuth flow (see below) |
| `SMTP_HOST` | SMTP server (e.g. `smtp.gmail.com`) |
| `SMTP_PORT` | SMTP port (e.g. `587`) |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password / app password |

Railway sets `PORT` automatically — no need to add it.

### 3. Connect Google Calendar

Once deployed, visit `https://your-app.up.railway.app/auth/google` in your browser, authorize, and add the returned refresh token as `GOOGLE_REFRESH_TOKEN` in Railway variables.

The Google OAuth redirect URI auto-detects your Railway domain (via `RAILWAY_PUBLIC_DOMAIN`).

### 4. Set up inbound email webhook

Point your email provider to your Railway URL:

**SendGrid Inbound Parse:**
- Settings > Inbound Parse > Add Host & URL
- URL: `https://your-app.up.railway.app/webhook/inbound`

**Mailgun Routes:**
- Create a route matching your agent email
- Forward to: `https://your-app.up.railway.app/webhook/inbound`

**Postmark Inbound:**
- Set inbound webhook URL to: `https://your-app.up.railway.app/webhook/inbound`

### 5. Follow-ups run automatically

No cron needed — the server runs follow-up checks every hour in-process. You can also trigger manually:

```bash
curl -X POST https://your-app.up.railway.app/api/follow-ups/process
```

## Local Development

```bash
npm install
cp .env.example .env  # fill in credentials
npm run dev
```

## Usage

Just CC `assistant@yourdomain.com` (your agent email) in any email thread:

```
To: lead@company.com
CC: assistant@yourdomain.com
Subject: Let's connect

Hi Sarah, I'd love to set up a time to chat...
```

The agent will:
1. Reply to the thread with your available time slots
2. Handle the lead's response (book if they pick a time, re-share if they ask for more options)
3. Automatically follow up if they don't respond (up to 3 times)
4. Notify you when a meeting is booked or when follow-ups are exhausted

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `POST` | `/webhook/inbound` | Inbound email webhook |
| `POST` | `/api/follow-ups/process` | Trigger follow-up processing |
| `GET` | `/api/conversations/:threadId` | Get conversation status |
| `GET` | `/auth/google` | Start Google OAuth flow |

## Architecture

```
src/
├── index.ts                  # Express server + routes
├── config.ts                 # Environment configuration
├── db.ts                     # SQLite database + schema
├── services/
│   ├── agent.ts              # Core agent logic (intent → action)
│   ├── calendar.ts           # Google Calendar (availability + booking)
│   ├── emailParser.ts        # Parse inbound emails (SendGrid/Mailgun/Postmark)
│   └── emailSender.ts        # Send emails via SMTP
└── jobs/
    └── processFollowUps.ts   # Follow-up cron job
```

## Follow-Up Sequence

The agent sends up to 3 follow-ups with escalating urgency:

1. **Follow-up 1** (after 48h): "Just wanted to follow up on scheduling..."
2. **Follow-up 2** (after 96h): "Checking in one more time..."
3. **Follow-up 3** (after 144h): "This is my last follow-up..." + notifies you

Follow-ups stop immediately if the lead responds, books a meeting, or declines.
