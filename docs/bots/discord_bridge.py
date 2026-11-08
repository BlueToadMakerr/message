"""Links one QuickMessage chat with one Discord channel (two-way).

Discord -> QuickMessage: every Discord message is posted by your QuickMessage bot "as" that Discord user (their name and avatar), with src="Discord".
QuickMessage -> Discord: new messages in the chat are sent to a Discord channel webhook with the sender's name.
The bot talks to QuickMessage through the database (qmbot.py), so nothing has to be exposed; the QuickMessage worker must be running.
pip install discord.py requests

Environment variables:
  QM_TOKEN         the bot's token (Bots page -> Show token)
  QM_DB_URL        your database address (shown on the Bots page), e.g. https://YOURPROJECT-default-rtdb.firebaseio.com
  QM_CHAT          the chat id (add the bot to that chat first)
  DISCORD_TOKEN    your Discord bot token (needs the "message content" intent)
  DISCORD_CHANNEL  the channel id to mirror
  DISCORD_WEBHOOK  a webhook URL of that channel (Channel settings -> Integrations -> Webhooks)
"""
import asyncio, os
import discord, requests
from qmbot import QMBot, QMError

bot = QMBot(os.environ["QM_TOKEN"], os.environ["QM_DB_URL"])
CHAT, CHANNEL, HOOK = os.environ["QM_CHAT"], int(os.environ["DISCORD_CHANNEL"]), os.environ["DISCORD_WEBHOOK"]

intents = discord.Intents.default(); intents.message_content = True
client = discord.Client(intents=intents)

@client.event
async def on_message(m: discord.Message):
    if m.channel.id != CHANNEL or m.webhook_id or m.author.bot: return          # never echo our own webhook posts back
    text = m.clean_content or ""
    for a in m.attachments: text += ("\n" if text else "") + a.url
    if not text.strip(): return
    try: await asyncio.to_thread(lambda: bot.send(CHAT, text[:4000], as_name=m.author.display_name, as_pfp=str(m.author.display_avatar.url), src="Discord"))
    except QMError as e: print("send:", e)

async def pump():
    """QuickMessage -> Discord."""
    await client.wait_until_ready()
    last = ""
    try: last = await asyncio.to_thread(bot.latest_event_key)                   # start at "now" so old messages aren't replayed
    except Exception as e: print("start:", e)
    while not client.is_closed():
        try:
            for key, ev in await asyncio.to_thread(lambda: bot.events(last)):
                last = key
                x = ev["message"]
                if ev["chat"] != CHAT or not x.get("text"): continue
                who = x["from"] + (" (bot)" if x.get("fromBot") else "")
                await asyncio.to_thread(lambda: requests.post(HOOK, json={"username": who[:80], "content": x["text"][:1900], "allowed_mentions": {"parse": []}}, timeout=15))
        except Exception as e: print("poll:", e)
        await asyncio.sleep(2)

async def main():
    async with client:
        asyncio.create_task(pump())
        await client.start(os.environ["DISCORD_TOKEN"])
asyncio.run(main())
