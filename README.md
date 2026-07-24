# EAS-4-TbSync (NielBuys fork)

> ### 🍴 About this fork
>
> A maintained fork of [jobisoft/EAS-4-TbSync](https://github.com/jobisoft/EAS-4-TbSync).
>
> **Purpose:** keep an up-to-date, **working** Exchange ActiveSync (EAS) provider — together with the TbSync core it runs on — functioning on current Thunderbird releases (Thunderbird 153+), with EAS 16.1 support.
>
> **Requires the matching TbSync core fork:** [NielBuys/TbSync](https://github.com/NielBuys/TbSync). Install **both** — this EAS provider relies on TB153 fixes that live in the forked TbSync core, so it will not work correctly on top of upstream TbSync on newer Thunderbird versions.

## Exchange Active Sync (EAS) protocol v 16.1 Initial Support

Initial support for protocol version 16.1 introduced in this version:
- Calendar/Contacts/Tasks editing and synchronization is working

## Known limitations

- **Accepting / rejecting meeting invitations does not notify the organizer.** The **Accept / Tentative / Decline** buttons on a calendar invitation do not send an RSVP back to the Exchange server (the EAS `MeetingResponse` command is not implemented yet). Clicking them may update the event locally, but the organizer is **not** informed of your response. To reply, use Outlook / Outlook Web for now. This is a planned feature.


I your server supports EAS v14 (Exchange 2016/2019/SE(?)) the add-on will autoselect EAS v16.1 protocol version whenever available.

This can be changed to desired version in 'Account Settings' in TbSync account manager.

([EAS protocol v 14 support for Exchange Online ends on 01.03.2026](https://techcommunity.microsoft.com/blog/exchange/exchange-online-activesync-device-support-update/4477997))

This provider add-on adds Exchange ActiveSync (EAS v2.5, v14 & v16.1) synchronization capabilities to [TbSync](https://github.com/jobisoft/TbSync/).

More information can be found in the [wiki](https://github.com/jobisoft/EAS-4-TbSync/wiki/About:-Provider-for-Exchange-ActiveSync) of this repository

## Want to add or fix a localization?
To help translating this project, please visit [crowdin.com](https://crowdin.com/profile/jobisoft), where the localizations are managed. If you want to add a new language, just contact me and I will set it up.


## External data sources

* TbSync uses a [timezone mapping](https://github.com/mj1856/TimeZoneConverter/blob/master/src/TimeZoneConverter/Data/Mapping.csv.gz) provided by [Matt Johnson](https://github.com/mj1856)


## Icon sources and attributions

#### CC0 Public Domain
* [365_*.png] by [Microsoft / Wikimedia](https://commons.wikimedia.org/w/index.php?curid=21546299), converted from [SVG to PNG](https://ezgif.com/svg-to-png)

#### CC-BY 3.0
* [eas*.png] by [FatCow Web Hosting](https://www.iconfinder.com/icons/64484/exchange_ms_icon)
* [exchange_300.png] derived from [Microsoft Exchange Icon #270871](https://icon-library.net/icon/microsoft-exchange-icon-10.html), [resized](www.simpleimageresizer.com/)