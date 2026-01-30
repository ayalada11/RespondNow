# RespondNow

An email agent you CC in your email threads to book meetings, share availability, and follow up with leads automatically.

## How It Works

1. **CC the agent** in any email to a lead/prospect
2. The agent **replies with your availability** from Google Calendar
3. When the lead picks a time, the agent **books the meeting** and sends calendar invites
4. If the lead doesn't respond, the agent **follows up 3 times** automatically
5. After 3 follow-ups with no response, it notifies you and stops

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in your `.env`:

| Variable | Description |
|---|---|
| `AGENT_EMAIL` | The email address for your agent (e.g. `assistant@yourdomain.com`) |
| `OPENAI_API_KEY` | OpenAI API key for intent classification |
| `GOOGLE_CLIENT_ID` | Google OAuth2 client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth2 client secret |
| `GOOGLE_REFRESH_TOKEN` | Get this by running the OAuth flow (see below) |
| `SMTP_HOST/PORT/USER/PASS` | SMTP credentials for sending emails |

### 3. Connect Google Calendar

```bash
npm run dev
```

Visit `http://localhost:3000/auth/google` in your browser, authorize the app, and copy the refresh token into your `.env`.

### 4. Set up inbound email webhook

Configure your email provider to forward inbound emails to your webhook:

**SendGrid Inbound Parse:**
- Settings > Inbound Parse > Add Host & URL
- URL: `https://yourdomain.com/webhook/inbound`

**Mailgun Routes:**
- Create a route matching your agent email
- Forward to: `https://yourdomain.com/webhook/inbound`

**Postmark Inbound:**
- Set inbound webhook URL to: `https://yourdomain.com/webhook/inbound`

### 5. Set up follow-up cron

Run follow-up processing on a schedule (e.g., every hour):

```bash
# crontab -e
0 * * * * cd /path/to/respond-now && npm run follow-up:process
```

Or trigger manually:

```bash
curl -X POST http://localhost:3000/api/follow-ups/process
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
