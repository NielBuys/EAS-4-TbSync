# EAS-4-TbSync (NielBuys fork)

Adds Microsoft **Exchange ActiveSync** (EAS) synchronization — calendars, contacts and tasks — to [TbSync](https://github.com/jobisoft/TbSync/) in Thunderbird.

> ### 🍴 About this fork
>
> A maintained fork of [jobisoft/EAS-4-TbSync](https://github.com/jobisoft/EAS-4-TbSync).
>
> **Purpose:** keep a **working** EAS provider — together with the TbSync core it runs on — functioning on current Thunderbird releases, and keep EAS 16.1 usable now that Exchange Online has retired EAS 14.
>
> **Requires the matching TbSync core fork:** [NielBuys/TbSync](https://github.com/NielBuys/TbSync). Install **both** — this provider relies on fixes that live in the forked core, so it will not work correctly on top of upstream TbSync on newer Thunderbird versions.
>
> Both forks use their own add-on IDs (`eas4tbsync@nielbuys.fork` / `tbsync@nielbuys.fork`) so that addons.thunderbird.net cannot silently replace them with the upstream versions.

## Requirements

| | |
|---|---|
| Thunderbird | 136 – 160 |
| TbSync core | [NielBuys/TbSync](https://github.com/NielBuys/TbSync) fork |
| Server | Exchange (on-premises or Exchange Online / Microsoft 365), or another EAS-compatible server such as Z-Push / Kopano or Horde |

## Installing

Both add-ons are installed from file — they are not on addons.thunderbird.net.

1. Download the `.xpi` for the **TbSync core fork** and for this **EAS provider**.
2. In Thunderbird: *Add-ons and Themes* → gear icon → *Install Add-on From File…* → pick the TbSync core XPI first, then this one.
3. Restart Thunderbird, then open *Tools → Synchronization Settings (TbSync)* and add an Exchange ActiveSync account.

## Protocol version support

EAS **2.5**, **14.0** and **16.1** are supported. The version is chosen per account in *TbSync account settings → ActiveSync version*:

- **Autodetect** (default) queries the server and picks the first version it offers, in the order **14.0 → 16.1 → 2.5**. So a server that still offers EAS 14 will be used with 14.0; 16.1 is selected when 14.0 is no longer offered — which is the case for Exchange Online.
- Any of **v2.5 / v14.0 / v16.1** can be selected explicitly. Sync fails with a clear error if the server does not advertise the version you picked.

If you want 16.1 on a server that still offers EAS 14, select **v16.1** manually.

> EAS 14 support for Exchange Online [ended on 2026-03-01](https://techcommunity.microsoft.com/blog/exchange/exchange-online-activesync-device-support-update/4477997). Autodetect handles this on its own, since the server simply stops advertising 14.0.

### EAS 16.1 notes

Calendar, contacts and task synchronization and editing work on 16.1. The protocol differs from 14.0 in ways that are handled internally: no `TimeZone` element (UTC timestamps are used instead), no `UID` in item data, `Location` moved to the AirSyncBase namespace, and changes to a single occurrence of a recurring event are sent as an `InstanceId` change on the master item rather than as a separate item.

## Meeting invitations (RSVP)

**Accept / Tentative / Decline** on a received calendar invitation is sent back to the server with the EAS `MeetingResponse` command, so the organizer and the other attendees see your response. This works both for a whole meeting and for a **single occurrence** of a recurring one — answering one occurrence answers only that occurrence, matching Outlook.

Previously the changed attendee status was pushed as an ordinary item change. Exchange interpreted that as *you* creating a new, self-organized meeting — duplicating the event and re-inviting everybody — and for a recurring meeting it silently did nothing at all. A freshly received, unanswered invitation is also no longer shown as already accepted (`ResponseType`/`AttendeeStatus` value `5` means *not responded*, not *accepted*).

### After upgrading from 4.17.x or earlier

Invitations that were already in your calendar were stored with the wrong participation status, and the add-on cannot tell from a local copy alone what the server really thinks. Those items are therefore left alone: they may still show as accepted when you never answered, and **responding to them does nothing** until they have been re-read from the server. Since ActiveSync only sends items that changed, they will not refresh on their own.

To fix them, force a full resync of the calendar folder: in the TbSync account manager **uncheck** the Calendar folder, sync, then **re-check** it and sync again. Make sure no local changes are still pending first, because this replaces the calendar target.

Invitations received after the upgrade are unaffected.

### Expected behaviour that looks like a bug

- **A declined meeting disappears from your calendar.** Exchange deletes it server-side once you decline and tells the client to remove it; Outlook behaves the same way. There is no setting to keep it.
- **A partially answered recurring meeting shows as *Tentative* at the series level.** That is how Exchange represents a series where some occurrences are answered and others are not.

### Known limitations

- **EAS 2.5 cannot answer a single occurrence** — the protocol has no `InstanceId` for `MeetingResponse`. The response is not sent and the event log says so, rather than answering the whole series behind your back. Use a newer ActiveSync version, or respond in Outlook.
- **Answering from the invitation e-mail** can leave a duplicate event in your calendar. Thunderbird's own iTIP handling records the response in a second, local copy of the event instead of the copy TbSync synced. That copy is detected and is *not* pushed to the server — your response is sent for the synced event, and the TbSync event log says so — but the stray local copy is left in place. Delete it manually if the event shows up twice.
- **Editing a received invitation while responding to it** in the same sync interval sends only the response; the other edits are not pushed. Exchange does not accept item edits from attendees anyway.

## Reporting problems

Please include the Thunderbird version, the EAS version in use, the server type (Exchange Online / Exchange on-premises / Z-Push / …), and the relevant part of the TbSync event log (*Synchronization Settings → Open event log*). Raising the log level in TbSync's settings before reproducing makes the log far more useful.

## Want to add or fix a localization?

Localizations of the upstream project are managed on [crowdin.com](https://crowdin.com/profile/jobisoft). Strings that only exist in this fork can be contributed directly as a pull request against `_locales/`.

## External data sources

* TbSync uses a [timezone mapping](https://github.com/mj1856/TimeZoneConverter/blob/master/src/TimeZoneConverter/Data/Mapping.csv.gz) provided by [Matt Johnson](https://github.com/mj1856)

## Further reading

More background on the provider can be found in the upstream [wiki](https://github.com/jobisoft/EAS-4-TbSync/wiki/About:-Provider-for-Exchange-ActiveSync).

## Icon sources and attributions

#### CC0 Public Domain
* [365_*.png] by [Microsoft / Wikimedia](https://commons.wikimedia.org/w/index.php?curid=21546299), converted from [SVG to PNG](https://ezgif.com/svg-to-png)

#### CC-BY 3.0
* [eas*.png] by [FatCow Web Hosting](https://www.iconfinder.com/icons/64484/exchange_ms_icon)
* [exchange_300.png] derived from [Microsoft Exchange Icon #270871](https://icon-library.net/icon/microsoft-exchange-icon-10.html), [resized](www.simpleimageresizer.com/)
