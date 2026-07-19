# How to use Webmirror — a plain-English guide

Webmirror makes a complete copy of a website on your own computer. Once the copy
is made, you can open it and click around exactly as you would on the real site —
even with no internet connection. Nothing on the real website is changed; the
tool only reads pages and saves them.

## Starting the tool

In the tool's folder you will find a file called **Start Webmirror**.
Double-click it. Two windows appear:

- a small black window — this is the tool's engine. Leave it alone while you
  work; when you are completely finished with Webmirror, close it to quit.
- a page called **Webmirror** in your web browser — this is the control panel,
  where you do everything. It runs entirely on your own computer; nothing is
  sent anywhere else.

(The very first time, the launcher may spend a minute or two setting itself up
before the panel appears. That happens only once.)

## Using the control panel

1. Fill in the three main boxes:

   - **Website address** — the site you want to copy, for example
     `example.com`. You do not need to type the `https://` part.
   - **Levels deep** — how far to follow links from the first page. Leave it
     blank to copy the whole site. Enter `1` to get just the first page and the
     pages it links to, `2` to go one step further, and so on. Smaller numbers
     mean a faster, smaller copy.
   - **Save location** — the folder on your computer where the copy will be
     kept. Press **Choose…** to pick a folder the normal Mac way.

2. Press **Start**. The panel shows live progress: how many pages and pictures
   have been saved, how many are still waiting, and anything that could not be
   fetched.

3. When it finishes, press **Open mirror** to view your copy in the browser.

### Stopping early

Press **Stop** at any time. The tool finishes what it is doing, saves its
progress, and stops neatly. If you later start it again with the same website
and the same save location, it carries on from where it left off instead of
starting over.

## The advanced options (optional)

You can ignore all of these — the standard settings work well. If you are
curious, click **Advanced options** to see:

- **Include subdomains** — some sites have sister addresses, such as
  `shop.example.com` alongside `example.com`. Keep this ticked to include them
  in the copy; untick it to stay strictly on the main address.
- **Page limit** — stop after saving this many pages, no matter what. Blank
  means no limit.
- **JavaScript rendering** — a few modern websites appear blank unless a real
  web browser assembles the page first. *Automatic* notices those pages and
  quietly uses a hidden browser to load them properly; *Never* skips that step;
  *Always* uses the hidden browser for every page (slower, rarely needed).
- **Skip URLs containing** — addresses to avoid, one per line. For example,
  adding `/logout` means any address containing `/logout` is skipped. Useful for
  leaving out sign-out links or endless printer-friendly pages.
- **Max file size (MB)** — skip any single file bigger than this many
  megabytes, so one enormous video cannot fill your disk.
- **Politeness delay (seconds)** — the tool pauses between pages so it does not
  overwhelm the website. You give it a shortest and a longest pause (for
  example, from `0.5` to `2` seconds) and it picks a natural, slightly varied
  pause within that range each time.
- **Respect robots.txt** — most websites publish a note saying which areas they
  would prefer automated visitors to stay out of. Leaving this ticked means the
  tool honours those wishes. We recommend keeping it on.
- **If a previous mirror exists** — *Resume* carries on from an earlier
  unfinished copy; *Fresh* throws the earlier progress away and downloads
  everything again from scratch.

## Common questions

**Where is my copy?** In the folder you chose as the save location. Open the
file called `index.html` inside it to start browsing, or use the **Open mirror**
button.

**My internet dropped / my computer went to sleep mid-copy.** No harm done. Run
it again with the same website and save location and it picks up where it
stopped.

**The website changed — can I update my copy?** Yes. Run it again with the same
save location and choose *Fresh* to download everything anew.

**Is this polite to the website?** Yes, by default. The tool pauses between
pages, honours the site's stated wishes, and only reads — it never changes
anything on the real site.
