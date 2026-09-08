/*
 * This file is part of EAS-4-TbSync.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. 
 */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
    CalAlarm: "resource:///modules/CalAlarm.sys.mjs",
    CalAttachment: "resource:///modules/CalAttachment.sys.mjs",
    CalAttendee: "resource:///modules/CalAttendee.sys.mjs",
    CalEvent: "resource:///modules/CalEvent.sys.mjs",
    CalTodo: "resource:///modules/CalTodo.sys.mjs",
});

var { ExtensionParent } = ChromeUtils.importESModule(
    "resource://gre/modules/ExtensionParent.sys.mjs"
);

var tbsyncExtension = ExtensionParent.GlobalManager.getExtension(
    "tbsync@nielbuys.fork"
);
var { TbSync } = ChromeUtils.importESModule(
    `chrome://tbsync/content/tbsync.sys.mjs?${tbsyncExtension.manifest.version}`
);

const cal = TbSync.lightning.cal;
const ICAL = TbSync.lightning.ICAL;

var Calendar = {

    // iCal PARTSTAT -> EAS MeetingResponse UserResponse ([MS-ASCMD] 2.2.3.166.3).
    // Note this is a *different* numeric scale from AttendeeStatus/ResponseType
    // (eas.sync.MAP_EAS2TB.ATTENDEESTATUS): 1 = Accept, 2 = Tentative, 3 = Decline.
    MAP_PARTSTAT2USERRESPONSE: { "ACCEPTED": "1", "TENTATIVE": "2", "DECLINED": "3" },

    // iCal PARTSTAT -> EAS ResponseType, used to re-stamp X-EAS-ResponseType after
    // the server accepted our MeetingResponse. Same scale as AttendeeStatus.
    MAP_PARTSTAT2RESPONSETYPE: { "TENTATIVE": "2", "ACCEPTED": "3", "DECLINED": "4" },

    // --------------------------------------------------------------------------- //
    // EAS 16.1 Helper: Is this item an exception occurrence?
    // --------------------------------------------------------------------------- //
    isExceptionItem: function (item) {
        return item.recurrenceId && item.recurrenceId.isValid;
    },

    // --------------------------------------------------------------------------- //
    // NEW: Build WBXML for a single-occurrence change (EAS 16.1)
    // --------------------------------------------------------------------------- //
    getWbxmlFromThunderbirdException: async function (tbItem, syncData, instanceId) {
        let item = tbItem instanceof TbSync.lightning.TbItem ? tbItem.nativeItem : tbItem;

        let wbxml = eas.wbxmltools.createWBXML("", syncData.type);
        wbxml.switchpage("AirSyncBase");
        wbxml.atag("InstanceId", instanceId);
        wbxml.switchpage(syncData.type);

        // Deletion of exception (works for both explicit delete and exceptions created with Deleted flag)
        if (item.recurrenceId) {
            wbxml.atag("Deleted", "1");
        } else {
            // Modified exception
            wbxml.append(await eas.sync.getWbxmlFromThunderbirdItem(item, syncData, true));
        }

        return wbxml.getBytes();
    },

    // --------------------------------------------------------------------------- //
    // Read WBXML and set Thunderbird item
    // --------------------------------------------------------------------------- //
    setThunderbirdItemFromWbxml: function (tbItem, data, id, syncdata, mode = "standard") {

        let item = tbItem instanceof TbSync.lightning.TbItem ? tbItem.nativeItem : tbItem;

        // EAS 16.1 incoming exception?
        if (data.InstanceId) {
            let instanceDate = cal.createDateTime(data.InstanceId).getInTimezone(cal.dtz.defaultTimezone);
            if (item.recurrenceInfo) {
                let occurrence = item.recurrenceInfo.getOccurrenceFor(instanceDate);
                if (occurrence) {
                    // We work on a clone of the occurrence so changes can be applied properly
                    item = occurrence.clone();
                    // Remember we are handling an exception so we can modifyException later
                    item._isIncomingException = true;
                    item._exceptionId = instanceDate;
                }
            }
        }

        let asversion = syncdata.accountData.getAccountProperty("asversion");
        item.id = id;
        eas.sync.setItemSubject(item, syncdata, data);
        if (TbSync.prefs.getIntPref("log.userdatalevel") > 2) TbSync.dump("Processing " + mode + " calendar item", item.title + " (" + id + ")");

        eas.sync.setItemLocation(item, syncdata, data);
        eas.sync.setItemCategories(item, syncdata, data);
        eas.sync.setItemBody(item, syncdata, data);

        //timezone
        let stdOffset = eas.defaultTimezoneInfo.std.offset;
        let dstOffset = eas.defaultTimezoneInfo.dst.offset;
        let easTZ = new eas.tools.TimeZoneDataStructure();
        if (data.TimeZone) {
            if (data.TimeZone == "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==") {
                TbSync.dump("Recieve TZ", "No timezone data received, using local default timezone.");
            } else {
                //load timezone struct into EAS TimeZone object
                easTZ.easTimeZone64 = data.TimeZone;
                if (TbSync.prefs.getIntPref("log.userdatalevel") > 2) TbSync.dump("Recieve TZ", item.title + easTZ.toString());
                stdOffset = easTZ.utcOffset;
                dstOffset = easTZ.daylightBias + easTZ.utcOffset;
            }
        }
        let timezone = eas.tools.guessTimezoneByStdDstOffset(stdOffset, dstOffset, easTZ.standardName);

        if (data.StartTime) {
            let utc = cal.createDateTime(data.StartTime); //format "19800101T000000Z" - UTC
            item.startDate = utc.getInTimezone(timezone);
            if (data.AllDayEvent && data.AllDayEvent == "1") {
                item.startDate.timezone = (cal.dtz && cal.dtz.floating) ? cal.dtz.floating : cal.floating();
                item.startDate.isDate = true;
            }
        }

        if (data.EndTime) {
            let utc = cal.createDateTime(data.EndTime);
            item.endDate = utc.getInTimezone(timezone);
            if (data.AllDayEvent && data.AllDayEvent == "1") {
                item.endDate.timezone = (cal.dtz && cal.dtz.floating) ? cal.dtz.floating : cal.floating();
                item.endDate.isDate = true;
            }
        }

        //stamp time cannot be set and it is not needed, an updated version is only send to the server, if there was a change, so stamp will be updated


        //EAS Reminder
        item.clearAlarms();
        if (data.Reminder && data.StartTime) {
            let alarm = new CalAlarm();
            alarm.related = Components.interfaces.calIAlarm.ALARM_RELATED_START;
            alarm.offset = cal.createDuration();
            alarm.action = "DISPLAY";
            // EAS 16.1 MS-ASCAL 2.2.2.38 : Reminder can be EMPTY
            let offsecs = parseInt(data.Reminder);
            if (!isNaN(offsecs)) {
                alarm.offset.inSeconds = (0 - offsecs * 60);
            }    

            item.addAlarm(alarm);

            let alarmData = cal.alarms.calculateAlarmDate(item, alarm);
            let startDate = cal.createDateTime(data.StartTime);
            let nowDate = eas.tools.getNowUTC();
            if (startDate.compare(nowDate) < 0) {
                // Mark alarm as ACK if in the past.
                item.alarmLastAck = nowDate;
            }
        }

        eas.sync.mapEasPropertyToThunderbird("BusyStatus", "TRANSP", data, item);
        eas.sync.mapEasPropertyToThunderbird("Sensitivity", "CLASS", data, item);

        if (data.ResponseType) {
            //store original EAS value 
            item.setProperty("X-EAS-ResponseType", eas.xmltools.checkString(data.ResponseType, "0")); //some server send empty ResponseType ???
        }

        //Attendees - remove all Attendees and re-add the ones from XML
        item.removeAllAttendees();
        if (data.Attendees && data.Attendees.Attendee) {
            let att = [];
            if (Array.isArray(data.Attendees.Attendee)) att = data.Attendees.Attendee;
            else att.push(data.Attendees.Attendee);
            for (let i = 0; i < att.length; i++) {
                if (att[i].Email && eas.tools.isString(att[i].Email) && att[i].Name) { //req.

                    let attendee = new CalAttendee();

                    //is this attendee the local EAS user?
                    let isSelf = (att[i].Email == syncdata.accountData.getAccountProperty("user"));

                    attendee["id"] = cal.email.prependMailTo(att[i].Email);
                    attendee["commonName"] = att[i].Name;
                    //default is "FALSE", only if THIS attendee isSelf, use ResponseRequested (we cannot respond for other attendee) - ResponseType is not send back to the server, it is just a local information
                    attendee["rsvp"] = (isSelf && data.ResponseRequested) ? "TRUE" : "FALSE";

                    //not supported in 2.5
                    switch (att[i].AttendeeType) {
                        case "1": //required
                            attendee["role"] = "REQ-PARTICIPANT";
                            attendee["userType"] = "INDIVIDUAL";
                            break;
                        case "2": //optional
                            attendee["role"] = "OPT-PARTICIPANT";
                            attendee["userType"] = "INDIVIDUAL";
                            break;
                        default: //resource or unknown
                            attendee["role"] = "NON-PARTICIPANT";
                            attendee["userType"] = "RESOURCE";
                            break;
                    }

                    //not supported in 2.5 - if attendeeStatus is missing, check if this isSelf and there is a ResponseType
                    if (att[i].AttendeeStatus)
                        attendee["participationStatus"] = eas.sync.MAP_EAS2TB.ATTENDEESTATUS[att[i].AttendeeStatus];
                    else if (isSelf && data.ResponseType)
                        attendee["participationStatus"] = eas.sync.MAP_EAS2TB.ATTENDEESTATUS[data.ResponseType];
                    else
                        attendee["participationStatus"] = "NEEDS-ACTION";

                    // status  : [NEEDS-ACTION, ACCEPTED, DECLINED, TENTATIVE, DELEGATED, COMPLETED, IN-PROCESS]
                    // rolemap : [REQ-PARTICIPANT, OPT-PARTICIPANT, NON-PARTICIPANT, CHAIR]
                    // typemap : [INDIVIDUAL, GROUP, RESOURCE, ROOM]

                    // Add attendee to event
                    item.addAttendee(attendee);
                } else {
                    TbSync.eventlog.add("info", syncdata, "Attendee without required name and/or email found. Skipped.");
                }
            }
        }

        // X-EAS-ResponseType is our record of the participation status the *server*
        // last reported for the local user. eas.sync.Calendar.detectInvitationResponses
        // compares it against the live PARTSTAT to tell an RSVP (Accept / Tentative /
        // Decline) apart from an ordinary edit, so it has to mirror exactly what the
        // attendee loop above just wrote into the self attendee - otherwise a plain
        // edit of a received meeting looks like an RSVP, or a real RSVP goes unnoticed.
        // X-EAS-SelfPartstat records the participation status we just wrote into the
        // user's own attendee entry from server data. detectInvitationResponses compares
        // the live PARTSTAT against it to tell an RSVP apart from an ordinary edit.
        //
        // Reading the attendee back through the very same getSelfAttendee lookup the
        // detection uses makes the two agree by construction, so an ordinary edit of a
        // received meeting can never be mistaken for an RSVP - not even on a server that
        // reports ResponseType and AttendeeStatus inconsistently, or that omits
        // ResponseType altogether (it is missing in 2.5 and optional elsewhere).
        //
        // Skipped for a partial Change, which carries no attendee data and must not be
        // allowed to blank an existing marker.
        if (data.Attendees) {
            let self = Calendar.getSelfAttendee(item, syncdata);
            item.setProperty("X-EAS-SelfPartstat",
                (self && self.participationStatus) ? self.participationStatus : "NEEDS-ACTION");
        }

        // The server side UID is not our item.id - that one holds the EAS ServerId.
        // Thunderbird's own itip engine keys invitations by UID, so keeping the real
        // UID around is what lets matchInvitationResponse pair a duplicate item
        // created by itip with the copy we already synced. Not sent in EAS 16.1.
        if (data.UID && eas.tools.isString(data.UID)) {
            item.setProperty("X-EAS-UID", data.UID);
        }

        if (data.OrganizerName && data.OrganizerEmail && eas.tools.isString(data.OrganizerEmail)) {
            //Organizer
            let organizer = new CalAttendee();
            organizer.id = cal.email.prependMailTo(data.OrganizerEmail);
            organizer.commonName = data.OrganizerName;
            organizer.rsvp = "FALSE";
            organizer.role = "CHAIR";
            organizer.userType = null;
            organizer.participationStatus = "ACCEPTED";
            organizer.isOrganizer = true;
            item.organizer = organizer;
        }

        eas.sync.setItemRecurrence(item, syncdata, data, timezone);

        // BusyStatus is always representing the status of the current user in terms of availability.
        // It has nothing to do with the status of a meeting. The user could be just the organizer, but does not need to attend, so he would be free.
        // The correct map is between BusyStatus and TRANSP (show time as avail, busy, unset)
        // A new event always sets TRANSP to busy, so unset is indeed a good way to store Tentiative
        // However:
        //  - EAS Meetingstatus only knows ACTIVE or CANCELLED, but not CONFIRMED or TENTATIVE
        //  - TB STATUS has UNSET, CONFIRMED, TENTATIVE, CANCELLED
        //  -> Special case: User sets BusyStatus to TENTIATIVE -> TRANSP is unset and also set STATUS to TENTATIVE
        // The TB STATUS is the correct map for EAS Meetingstatus and should be unset, if it is not a meeting EXCEPT if set to TENTATIVE
        let tbStatus = (data.BusyStatus && data.BusyStatus == "1" ? "TENTATIVE" : null);

        if (data.MeetingStatus) {
            //store original EAS value 
            item.setProperty("X-EAS-MeetingStatus", data.MeetingStatus);
            //bitwise representation for Meeting, Received, Cancelled:
            let M = data.MeetingStatus & 0x1;
            let R = data.MeetingStatus & 0x2;
            let C = data.MeetingStatus & 0x4;

            // We can map M+C to TB STATUS (TENTATIVE, CONFIRMED, CANCELLED, unset).
            if (M) {
                if (C) tbStatus = "CANCELLED";
                else if (!tbStatus) tbStatus = "CONFIRMED"; // do not override "TENTIATIVE"
            }

            //we can also use the R information, to update our fallbackOrganizerName
            if (!R && data.OrganizerName) syncdata.target.calendar.setProperty("fallbackOrganizerName", data.OrganizerName);
        }

        if (tbStatus) item.setProperty("STATUS", tbStatus)
        else item.deleteProperty("STATUS");

        // Exchange prepends a localized "Canceled: " to the Subject of a cancelled
        // meeting (or cancelled occurrence of a recurring series). That word is
        // redundant with STATUS=CANCELLED - which already renders the item
        // struck-through - and, because it is baked into the stored title, it
        // lingers even after the occurrence is reactivated or moved. Strip it so a
        // cancelled item shows a clean, struck-through title, matching CalDAV/Google.
        // (Handles the English "Canceled:"/"Cancelled:" prefix; other UI locales
        // would need their localized word added here.)
        if (tbStatus == "CANCELLED" && item.title) {
            item.title = item.title.replace(/^\s*cancell?ed:\s*/i, "");
        }

        // If this was an incoming exception, properly register it on the master
        if (item._isIncomingException) {
            let master = tbItem instanceof TbSync.lightning.TbItem ? tbItem.nativeItem : tbItem;
            master.recurrenceInfo.modifyException(item, true);
            delete item._isIncomingException;
            delete item._exceptionId;
        }

        //TODO: attachements (needs EAS 16.0!)
    },

    // --------------------------------------------------------------------------- //
    //read TB event and return its data as WBXML
    // --------------------------------------------------------------------------- //
    getWbxmlFromThunderbirdItem: async function (tbItem, syncdata, isException = false) {
        let item = tbItem instanceof TbSync.lightning.TbItem ? tbItem.nativeItem : tbItem;

        let asversion = syncdata.accountData.getAccountProperty("asversion");
        let wbxml = eas.wbxmltools.createWBXML("", syncdata.type); //init wbxml with "" and not with precodes, and set initial codepage
        let nowDate = new Date();

        /*
         *  We do not use ghosting, that means, if we do not include a value in CHANGE, it is removed from the server. 
         *  However, this does not seem to work on all fields. Furthermore, we need to include any (empty) container to blank its childs.
         */

        //Order of tags taken from https://msdn.microsoft.com/en-us/library/dn338917(v=exchg.80).aspx

        //timezone
        if (!isException) {
            let easTZ = new eas.tools.TimeZoneDataStructure();

            //if there is no end and no start (or both are floating) use default timezone info
            let tzInfo = null;
            if (item.startDate && item.startDate.timezone.tzid != "floating") tzInfo = eas.tools.getTimezoneInfo(item.startDate.timezone);
            else if (item.endDate && item.endDate.timezone.tzid != "floating") tzInfo = eas.tools.getTimezoneInfo(item.endDate.timezone);
            if (!tzInfo) tzInfo = eas.defaultTimezoneInfo;

            easTZ.utcOffset = tzInfo.std.offset;
            easTZ.standardBias = 0;
            easTZ.daylightBias = tzInfo.dst.offset - tzInfo.std.offset;

            easTZ.standardName = eas.ianaToWindowsTimezoneMap.hasOwnProperty(tzInfo.std.displayname) ? eas.ianaToWindowsTimezoneMap[tzInfo.std.displayname] : tzInfo.std.displayname;
            easTZ.daylightName = eas.ianaToWindowsTimezoneMap.hasOwnProperty(tzInfo.dst.displayname) ? eas.ianaToWindowsTimezoneMap[tzInfo.dst.displayname] : tzInfo.dst.displayname;

            if (tzInfo.std.switchdate && tzInfo.dst.switchdate) {
                easTZ.standardDate.wMonth = tzInfo.std.switchdate.month;
                easTZ.standardDate.wDay = tzInfo.std.switchdate.weekOfMonth;
                easTZ.standardDate.wDayOfWeek = tzInfo.std.switchdate.dayOfWeek;
                easTZ.standardDate.wHour = tzInfo.std.switchdate.hour;
                easTZ.standardDate.wMinute = tzInfo.std.switchdate.minute;
                easTZ.standardDate.wSecond = tzInfo.std.switchdate.second;

                easTZ.daylightDate.wMonth = tzInfo.dst.switchdate.month;
                easTZ.daylightDate.wDay = tzInfo.dst.switchdate.weekOfMonth;
                easTZ.daylightDate.wDayOfWeek = tzInfo.dst.switchdate.dayOfWeek;
                easTZ.daylightDate.wHour = tzInfo.dst.switchdate.hour;
                easTZ.daylightDate.wMinute = tzInfo.dst.switchdate.minute;
                easTZ.daylightDate.wSecond = tzInfo.dst.switchdate.second;
            }


            // for EAS 16.1 dont send TimeZone at all since we use UTC timestamps this should work.  
            if (asversion != "16.1") {
                // EAS 16 [MS-ASCAL] 2.2.2.1 
                // if (asversion == "16.1" && item.startDate && item.startDate.isDate && item.endDate && item.endDate.isDate) {
                // client MUST NOT send TimeZone
                // } else {
                wbxml.atag("TimeZone", easTZ.easTimeZone64);
                if (TbSync.prefs.getIntPref("log.userdatalevel") > 2) TbSync.dump("Send TZ", item.title + easTZ.toString());
                // }
            }
        }

        //AllDayEvent (for simplicity, we always send a value)
        // not ALWAYS in EAS 16: [MS-ASCAL] 2.2.2.1 .. but seems OK...
        wbxml.atag("AllDayEvent", (item.startDate && item.startDate.isDate && item.endDate && item.endDate.isDate) ? "1" : "0");

        //Body
        wbxml.append(eas.sync.getItemBody(item, syncdata));

        //BusyStatus (Free, Tentative, Busy) is taken from TRANSP (busy, free, unset=tentative)
        //However if STATUS is set to TENTATIVE, overide TRANSP and set BusyStatus to TENTATIVE
        if (item.hasProperty("STATUS") && item.getProperty("STATUS") == "TENTATIVE") {
            wbxml.atag("BusyStatus", "1");
        } else {
            wbxml.atag("BusyStatus", eas.sync.mapThunderbirdPropertyToEas("TRANSP", "BusyStatus", item));
        }

        //Organizer
        if (asversion != "16.1" && !isException) {
            // not in EAS 16: [MS-ASCAL] 2.2.2.35 / 36
            if (item.organizer && item.organizer.commonName) wbxml.atag("OrganizerName", item.organizer.commonName);
            if (item.organizer && item.organizer.id) wbxml.atag("OrganizerEmail", cal.email.removeMailTo(item.organizer.id));
        }

        //DtStamp in UTC
        if (asversion != "16.1") {
            // not in EAS 16: [MS-ASCAL] 2.2.2.18
            wbxml.atag("DtStamp", item.stampTime ? eas.tools.getIsoUtcString(item.stampTime) : eas.tools.dateToBasicISOString(nowDate));
        }
        
        //EndTime in UTC
        // EAS 16 [MS-ASCAL] 2.2.2.1 -> no time component
        if (asversion == "16.1" && item.startDate && item.startDate.isDate && item.endDate && item.endDate.isDate) {
            wbxml.atag("EndTime",eas.tools.getIsoUtcString(item.endDate,false,true,true));
        } else {
            wbxml.atag("EndTime", item.endDate ? eas.tools.getIsoUtcString(item.endDate) : eas.tools.dateToBasicISOString(nowDate));
        }
        
        //Location
        if (asversion != "16.1") {
            // not in EAS 16: [MS-ASCAL] 2.2.2.27
            wbxml.atag("Location", (item.hasProperty("location")) ? item.getProperty("location") : "");
        } else {    
            // EAS 16 MS-AIRS 2.2.2.28
            if (item.hasProperty("location")) {
                wbxml.switchpage("AirSyncBase");
                wbxml.otag("Location");
                wbxml.atag("DisplayName", item.getProperty("location"));
                wbxml.ctag();
                wbxml.switchpage(syncdata.type);
            }
        }
        
        //EAS Reminder (TB getAlarms) - at least with zpush blanking by omitting works, horde does not work
        let alarms = item.getAlarms({});
        if (alarms.length > 0) {

            let reminder = -1;
            if (alarms[0].offset !== null) {
                reminder = 0 - alarms[0].offset.inSeconds / 60;
            } else if (item.startDate) {
                let timeDiff = item.startDate.getInTimezone(eas.utcTimezone).subtractDate(alarms[0].alarmDate.getInTimezone(eas.utcTimezone));
                reminder = timeDiff.inSeconds / 60;
                TbSync.eventlog.add("info", syncdata, "Converting absolute alarm to relative alarm (not supported).", item.icalString);
            }
            if (reminder >= 0) wbxml.atag("Reminder", reminder.toString());
            else TbSync.eventlog.add("info", syncdata, "Droping alarm after start date (not supported).", item.icalString);

        }

        //Sensitivity (CLASS)
        wbxml.atag("Sensitivity", eas.sync.mapThunderbirdPropertyToEas("CLASS", "Sensitivity", item));

        //Subject (obmitting these, should remove them from the server - that does not work reliably, so we send blanks)
        wbxml.atag("Subject", (item.title) ? item.title : "");

        //StartTime in UTC
        // EAS 16 [MS-ASCAL] 2.2.2.1
        if (asversion == "16.1" && item.startDate && item.startDate.isDate && item.endDate && item.endDate.isDate) {
            wbxml.atag("StartTime",eas.tools.getIsoUtcString(item.startDate,false,true,true)); 
        } else {
            wbxml.atag("StartTime", item.startDate ? eas.tools.getIsoUtcString(item.startDate) : eas.tools.dateToBasicISOString(nowDate));
        }

        //UID (limit to 300)
        //each TB event has an ID, which is used as EAS serverId - however there is a second UID in the ApplicationData
        //since we do not have two different IDs to use, we use the same ID
        // EAS 16.1 MS-ASCAL 2.2.2.46 UID MUST NOT be present
        if (asversion != "16.1") {
            if (!isException) { //docs say it would be allowed in exception in 2.5, but it does not work, if present
                wbxml.atag("UID", item.id);
            }
        } else {
            // EAS 16.1 MS-ASCAL 2.2.2.13 optional ClientUid
            //for some reason when defined Exchange Online rejects many change requests ... oh well .. since it is optional lets skip it ... 
            //wbxml.atag("ClientUid", item.id);
        }
        //IMPORTANT in EAS v16 it is no longer allowed to send a UID
        //Only allowed in exceptions in v2.5


        //EAS MeetingStatus
        // 0 (000) The event is an appointment, which has no attendees.
        // 1 (001) The event is a meeting and the user is the meeting organizer.
        // 3 (011) This event is a meeting, and the user is not the meeting organizer; the meeting was received from someone else.
        // 5 (101) The meeting has been canceled and the user was the meeting organizer.
        // 7 (111) The meeting has been canceled. The user was not the meeting organizer; the meeting was received from someone else

        //there are 3 fields; Meeting, Owner, Cancelled
        //M can be reconstructed from #of attendees (looking at the old value is not wise, since it could have been changed)
        //C can be reconstucted from TB STATUS
        //O can be reconstructed by looking at the original value, or (if not present) by comparing EAS ownerID with TB ownerID

        let attendees = item.getAttendees();
        //if (!(isException && asversion == "2.5")) { //MeetingStatus is not supported in exceptions in EAS 2.5
        if (!isException) { //Exchange 2010 does not seem to support MeetingStatus at all in exceptions
            if (attendees.length == 0) wbxml.atag("MeetingStatus", "0");
            else {
                //get owner information
                let isReceived = false;
                if (item.hasProperty("X-EAS-MEETINGSTATUS")) isReceived = item.getProperty("X-EAS-MEETINGSTATUS") & 0x2;
                else isReceived = (item.organizer && item.organizer.id && cal.email.removeMailTo(item.organizer.id) != syncdata.accountData.getAccountProperty("user"));

                //either 1,3,5 or 7
                if (item.hasProperty("STATUS") && item.getProperty("STATUS") == "CANCELLED") {
                    //either 5 or 7
                    wbxml.atag("MeetingStatus", (isReceived ? "7" : "5"));
                } else {
                    //either 1 or 3
                    wbxml.atag("MeetingStatus", (isReceived ? "3" : "1"));
                }
            }
        }

        //Attendees
        let TB_responseType = null;
        if (!(isException && asversion == "2.5")) { //attendees are not supported in exceptions in EAS 2.5
            if (attendees.length > 0) { //We should use it instead of countAttendees.value
                wbxml.otag("Attendees");
                for (let attendee of attendees) {
                    wbxml.otag("Attendee");
                    wbxml.atag("Email", cal.email.removeMailTo(attendee.id));
                    wbxml.atag("Name", (attendee.commonName ? attendee.commonName : cal.email.removeMailTo(attendee.id).split("@")[0]));
                    if (asversion != "2.5") {
                        //it's pointless to send AttendeeStatus, 
                        // - if we are the owner of a meeting, TB does not have an option to actually set the attendee status (on behalf of an attendee) in the UI
                        // - if we are an attendee (of an invite) we cannot and should not set status of other attendees and or own status must be send through a MeetingResponse
                        // -> all changes of attendee status are send from the server to us, either via ResponseType or via AttendeeStatus
                        //wbxml.atag("AttendeeStatus", eas.sync.MAP_TB2EAS.ATTENDEESTATUS[attendee.participationStatus]);

                        if (attendee.userType == "RESOURCE" || attendee.userType == "ROOM" || attendee.role == "NON-PARTICIPANT") wbxml.atag("AttendeeType", "3");
                        else if (attendee.role == "REQ-PARTICIPANT" || attendee.role == "CHAIR") wbxml.atag("AttendeeType", "1");
                        else wbxml.atag("AttendeeType", "2"); //leftovers are optional
                    }
                    wbxml.ctag();
                }
                wbxml.ctag();
            } else {
                if (asversion != "16.1") {
                    wbxml.atag("Attendees"); 
                }
            }
        }

        //Categories (see https://github.com/jobisoft/TbSync/pull/35#issuecomment-359286374)
        if (!isException) {
            wbxml.append(eas.sync.getItemCategories(item, syncdata));
        }

        //recurrent events (implemented by Chris Allan)
        if (!isException) {
            wbxml.append(await eas.sync.getItemRecurrence(item, syncdata));
        }


        //---------------------------

        //TP PRIORITY (9=LOW, 5=NORMAL, 1=HIGH) not mapable to EAS Event
        //TODO: attachements (needs EAS 16.0!)

        //https://dxr.mozilla.org/comm-central/source/calendar/base/public/calIAlarm.idl
        //TbSync.dump("ALARM ("+i+")", [, alarms[i].related, alarms[i].repeat, alarms[i].repeatOffset, alarms[i].repeatDate, alarms[i].action].join("|"));

        return wbxml.getBytes();
    },

    // --------------------------------------------------------------------------- //
    // MeetingResponse (RSVP) helpers
    //
    // Accepting / tentatively accepting / declining an invitation has to be sent
    // with the EAS MeetingResponse command (eas.network.sendMeetingResponse), never
    // as a generic Sync <Change> of the item: Exchange reads such a change as "the
    // user created a new, self organized meeting", duplicating the event and
    // re-inviting every attendee. Once it has our MeetingResponse the server updates
    // the organizer's copy and notifies the attendees itself.
    //
    // Everything below decides from item data alone, no UI hook or call stack
    // sniffing needed, and is only ever called for Calendar folders.
    // --------------------------------------------------------------------------- //

    nativeItem: function (tbItem) {
        return tbItem instanceof TbSync.lightning.TbItem ? tbItem.nativeItem : tbItem;
    },

    // The attendee entry of the local EAS user, or null.
    getSelfAttendee: function (tbItem, syncdata) {
        let item = Calendar.nativeItem(tbItem);
        let userEmail = syncdata.accountData.getAccountProperty("user");
        if (!userEmail) return null;
        userEmail = userEmail.toLowerCase();
        for (let attendee of item.getAttendees()) {
            if (!attendee.id) continue;
            if (cal.email.removeMailTo(attendee.id).toLowerCase() == userEmail) return attendee;
        }
        return null;
    },

    // Bit 0x2 of EAS MeetingStatus: the meeting was received from someone else, so
    // the user is an attendee and not the organizer. We only ever set this property
    // from server data, which means its absence also tells us that an item never
    // came from the server. Occurrences do not always carry their own copy, so fall
    // back to the master they belong to.
    isReceivedMeeting: function (tbItem) {
        let item = Calendar.nativeItem(tbItem);
        for (let candidate of [item, item.parentItem]) {
            if (!candidate || typeof candidate.hasProperty != "function") continue;
            if (!candidate.hasProperty("X-EAS-MeetingStatus")) continue;
            return (parseInt(candidate.getProperty("X-EAS-MeetingStatus"), 10) & 0x2) != 0;
        }
        return false;
    },

    // Every pending RSVP on this item: the series level response, plus one per modified
    // occurrence.
    //
    // A whole recurring series is a single EAS item (one ServerId), so a changelog entry
    // always names the master. Thunderbird, however, records an Accept clicked on one
    // occurrence by creating an *exception* for it - which is what accepting a recurring
    // invitation from the calendar view always does. The exception inherits the master's
    // X-EAS-SelfPartstat while its own PARTSTAT changes, so the mismatch is visible here
    // and is answered with MeetingResponse's InstanceId element.
    //
    // Returns an array of { userResponse, partstat, instanceId, exceptionId }, where
    // instanceId is null for a series level response and otherwise the UTC timestamp
    // identifying the occurrence. Empty when nothing is a real Accept/Tentative/Decline
    // transition - the caller then treats the change as an ordinary edit.
    detectInvitationResponses: function (tbItem, syncdata) {
        let item = Calendar.nativeItem(tbItem);
        if (!Calendar.isReceivedMeeting(item)) return [];

        // Called with a single occurrence rather than the master.
        if (Calendar.isExceptionItem(item)) {
            let response = Calendar.compareSelfPartstat(item, syncdata);
            if (!response) return [];
            response.instanceId = Calendar.meetingResponseInstanceId(item.recurrenceId);
            response.exceptionId = item.recurrenceId;
            return [response];
        }

        let responses = [];

        let master = Calendar.compareSelfPartstat(item, syncdata);
        if (master) {
            master.instanceId = null;
            master.exceptionId = null;
            responses.push(master);
        }

        if (item.recurrenceInfo) {
            for (let exceptionId of item.recurrenceInfo.getExceptionIds({})) {
                let exception = item.recurrenceInfo.getExceptionFor(exceptionId);
                if (!exception) continue;
                let response = Calendar.compareSelfPartstat(exception, syncdata);
                if (!response) continue;
                response.instanceId = Calendar.meetingResponseInstanceId(exceptionId);
                response.exceptionId = exceptionId;
                responses.push(response);
            }
        }

        return responses;
    },

    // The occurrence identifier for MeetingResponse's InstanceId element.
    //
    // Beware: this is NOT the same format as the AirSyncBase InstanceId used when
    // pushing a 16.1 exception change (getWbxmlFromThunderbirdException above), even
    // though both are "a UTC timestamp identifying an occurrence". MeetingResponseRequest
    // .xsd restricts InstanceId to exactly 24 characters, i.e. the extended form
    // 2026-08-10T07:45:00.000Z, while AirSyncBase uses the 16 character basic form
    // 20260810T074500Z. Sending the basic form here makes Exchange reject the whole
    // request with MeetingResponse Status 2 ("invalid meeting request"), which is
    // indistinguishable from a genuinely stale meeting - so keep the two apart.
    meetingResponseInstanceId: function (occurrenceId) {
        return eas.tools.getIsoUtcString(occurrenceId, /* requireExtendedISO */ true);
    },

    // The marker comparison for one item or occurrence: is the live participation status
    // of the user's own attendee entry a real RSVP transition away from what the server
    // last told us? Returns { userResponse, partstat } or null (no self attendee, no
    // change, a status MeetingResponse has no code for such as a reset to NEEDS-ACTION,
    // or a status we cannot vouch for - see the marker check below).
    compareSelfPartstat: function (item, syncdata) {
        // X-EAS-SelfPartstat doubles as a version marker, and its absence must never be
        // treated as "NEEDS-ACTION". Items synced by a build before this property
        // existed carry a PARTSTAT produced by the old AttendeeStatus mapping, which
        // turned "not responded" (5) into ACCEPTED. Comparing a live ACCEPTED against an
        // assumed NEEDS-ACTION would look like a real Accept transition and fire a
        // MeetingResponse for an invitation the user never answered - on any local write
        // to the item, including Thunderbird acknowledging a reminder. So treat a
        // missing marker as "server side status unknown" and stay out of the way until
        // the item has been re-read from the server.
        if (!item.hasProperty("X-EAS-SelfPartstat")) return null;
        let lastPartstat = item.getProperty("X-EAS-SelfPartstat");

        let attendee = Calendar.getSelfAttendee(item, syncdata);
        if (!attendee) return null;

        let currentPartstat = attendee.participationStatus ? attendee.participationStatus : "NEEDS-ACTION";
        if (currentPartstat == lastPartstat) return null;

        let userResponse = Calendar.MAP_PARTSTAT2USERRESPONSE[currentPartstat];
        if (!userResponse) return null;

        return { userResponse: userResponse, partstat: currentPartstat };
    },

    // Record the response once the server accepted our MeetingResponse, so the next
    // sync pass does not detect and re-send it. Written via target.modifyItem, which
    // pretags the changelog with a "_by_server" entry, so this write is not mistaken
    // for yet another user change. exceptionId selects a single occurrence; pass null
    // to stamp the series itself.
    stampInvitationResponse: async function (tbItem, partstat, exceptionId, syncdata) {
        let responseType = Calendar.MAP_PARTSTAT2RESPONSETYPE[partstat];
        let newItem = tbItem.clone();

        if (exceptionId) {
            let master = Calendar.nativeItem(newItem);
            if (!master.recurrenceInfo) return;
            let exception = master.recurrenceInfo.getExceptionFor(exceptionId);
            if (!exception) return;
            let stamped = exception.clone();
            stamped.setProperty("X-EAS-SelfPartstat", partstat);
            if (responseType) stamped.setProperty("X-EAS-ResponseType", responseType);
            master.recurrenceInfo.modifyException(stamped, true);
        } else {
            newItem.setProperty("X-EAS-SelfPartstat", partstat);
            if (responseType) newItem.setProperty("X-EAS-ResponseType", responseType);
        }

        await syncdata.target.modifyItem(newItem, tbItem);
    },

    // Thunderbird's own itip engine answers an emailed invitation by looking for a
    // calendar item carrying the *organizer's* UID. Our synced copy is stored under
    // the EAS ServerId instead, so itip usually finds nothing and records the
    // response in a second, parallel item that has none of our X-EAS-* markers.
    // Pushed as a plain Add, Exchange turns that into a brand new self organized
    // meeting: the event is duplicated and everybody is invited again.
    //
    // Recognise such an item and pair it with the copy we already synced, preferring
    // an exact match on the server side UID stamped as X-EAS-UID (not available in
    // EAS 16.1, which does not send UID) and falling back to subject + start + end.
    //
    // Returns { serverID, userResponse, partstat, exact } for the tracked item the
    // response belongs to, or null when this really is a new meeting the user is
    // organizing.
    matchInvitationResponse: async function (candidateTbItem, syncdata) {
        let candidate = Calendar.nativeItem(candidateTbItem);

        // Everything we ever pulled from the server carries X-EAS-MeetingStatus, so
        // its presence means this is not an itip created item and must not be matched.
        if (candidate.hasProperty("X-EAS-MeetingStatus")) return null;
        if (Calendar.isExceptionItem(candidate)) return null;
        if (!candidate.startDate || !candidate.endDate) return null;

        // Without an actual response this is just a new meeting the user created.
        let attendee = Calendar.getSelfAttendee(candidate, syncdata);
        if (!attendee) return null;
        let partstat = attendee.participationStatus;
        let userResponse = Calendar.MAP_PARTSTAT2USERRESPONSE[partstat];
        if (!userResponse) return null;

        let candidateTitle = candidate.title ? candidate.title.trim() : "";
        let items = await Calendar.getItemsInRange(syncdata.target.calendar, candidate.startDate, candidate.endDate, syncdata);

        let fuzzyMatch = null;
        for (let existing of items) {
            if (existing.id == candidate.id) continue;
            if (!Calendar.isReceivedMeeting(existing)) continue;

            // Exact: the UID of the invitation, which is also the id itip gave the
            // item it created.
            if (candidate.id && existing.hasProperty("X-EAS-UID") && existing.getProperty("X-EAS-UID") == candidate.id) {
                return { serverID: existing.id, userResponse: userResponse, partstat: partstat, exact: true };
            }

            if (fuzzyMatch === null
                && candidateTitle
                && existing.title && existing.title.trim() == candidateTitle
                && existing.startDate && existing.startDate.compare(candidate.startDate) == 0
                && existing.endDate && existing.endDate.compare(candidate.endDate) == 0) {
                // do not return yet, an exact UID match further down the list wins
                fuzzyMatch = existing.id;
            }
        }

        if (fuzzyMatch) {
            return { serverID: fuzzyMatch, userResponse: userResponse, partstat: partstat, exact: false };
        }
        return null;
    },

    // Master events of a calendar overlapping [rangeStart, rangeEnd], widened by a
    // day on each side to stay clear of timezone and all-day edge cases. Thunderbird
    // moved calICalendar.getItems from a callback to an array to a ReadableStream
    // over the years, so detect the shape instead of pinning one - and never let a
    // future change of that API break the sync: an empty result only means we do not
    // recognize a duplicate, it does not lose any data.
    getItemsInRange: async function (calendar, rangeStart, rangeEnd, syncdata) {
        try {
            let oneDayBack = cal.createDuration();
            oneDayBack.inSeconds = -86400;
            let oneDayAhead = cal.createDuration();
            oneDayAhead.inSeconds = 86400;

            let from = rangeStart.clone();
            from.addDuration(oneDayBack);
            let to = rangeEnd.clone();
            to.addDuration(oneDayAhead);

            // no ITEM_FILTER_CLASS_OCCURRENCES, we only want the master items
            let filter = Components.interfaces.calICalendar.ITEM_FILTER_TYPE_EVENT;

            if (typeof calendar.getItemsAsArray == "function") {
                return await calendar.getItemsAsArray(filter, 0, from, to);
            }

            let result = calendar.getItems(filter, 0, from, to);
            if (result && typeof result.getReader == "function") {
                let items = [];
                let reader = result.getReader();
                for (; ;) {
                    let chunk = await reader.read();
                    if (chunk.done) break;
                    if (Array.isArray(chunk.value)) items.push(...chunk.value);
                    else if (chunk.value) items.push(chunk.value);
                }
                return items;
            }

            let resolved = await result;
            return Array.isArray(resolved) ? resolved : [];
        } catch (e) {
            TbSync.eventlog.add("info", syncdata ? syncdata.eventLogInfo : null,
                "Could not enumerate calendar items, cannot check whether this is a duplicate invitation response.",
                e.message);
            return [];
        }
    }
}
// Export Calendar object so sync.js can use it
eas.sync.Calendar = Calendar;