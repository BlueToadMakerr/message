"""Links one QuickMessage chat with one Discord channel (two-way).

Discord -> QuickMessage: every Discord message is posted by your QuickMessage bot "as" that Discord user (their name and avatar), with src="Discord".
QuickMessage -> Discord: new messages in the chat are sent to a Discord channel webhook with the sender's name and picture.
It polls QuickMessage (no public address needed), so run it anywhere: pip install discord.py requests

Set these environment variables:
  QM_API      the address shown on the Bots page, e.g. https://us-central1-YOURPROJECT.cloudfunctions.net/botApi
  QM_TOKEN    the bot's token (qmbot.bot_xxx.yyy)
  QM_CHAT     the chat id (the bot must have been added to that chat)
  DISCORD_TOKEN    your Discord bot token (needs the "message content" intent)
  DISCORD_CHANNEL  the channel id to mirror
  DISCORD_WEBHOOK  a webhook URL of that channel (Channel settings -> Integrations -> Webhooks)
"""
import asyncio, os, time
import discord, requests

API, TOKEN, CHAT = os.environ["QM_API"].rstrip("/"), os.environ["QM_TOKEN"], os.environ["QM_CHAT"]
CHANNEL, HOOK = int(os.environ["DISCORD_CHANNEL"]), os.environ["DISCORD_WEBHOOK"]
H = {"Authorization": "Bearer " + TOKEN}

def qm(method, path, **kw):
    r = requests.request(method, API + path, headers=H, timeout=15, **kw)
    r.raise_for_status()
    return r.json()

intents = discord.Intents.default(); intents.message_content = True
client = discord.Client(intents=intents)

@client.event
async def on_message(m: discord.Message):
    if m.channel.id != CHANNEL or m.webhook_id or m.author.bot: return          # never echo our own webhook posts back
    text = m.clean_content or ""
    for a in m.attachments: text += ("\n" if text else "") + a.url
    if not text.strip(): return
    await asyncio.to_thread(lambda: qm("POST", "/send", json={"chat": CHAT, "text": text[:4000], "src": "Discord",
        "as": {"name": m.author.display_name, "pfp": str(m.author.display_avatar.url)}}))

async def pump():
    """QuickMessage -> Discord."""
    await client.wait_until_ready()
    last = ""
    try:                                                                        # start from the newest message so old history isn't replayed
        msgs = (await asyncio.to_thread(lambda: qm("GET", "/messages", params={"chat": CHAT, "limit": 1})))["messages"]
        last = msgs[-1]["id"] if msgs else ""
    except Exception as e: print("start:", e)
    while not client.is_closed():
        try:
            msgs = (await asyncio.to_thread(lambda: qm("GET", "/messages", params={"chat": CHAT, "after": last, "limit": 50})))["messages"]
            for x in msgs:
                last = x["id"]
                if x["fromMe"] or not x.get("text"): continue                    # skip what this bot posted (that came from Discord)
                who = x["from"] + (" (bot)" if x.get("fromBot") else "")
                await asyncio.to_thread(lambda: requests.post(HOOK, json={"username": who[:80], "content": x["text"][:1900], "allowed_mentions": {"parse": []}}, timeout=15))
        except Exception as e: print("poll:", e)
        await asyncio.sleep(2)

async def main():
    async with client:
        asyncio.create_task(pump())
        await client.start(os.environ["DISCORD_TOKEN"])
asyncio.run(main())
