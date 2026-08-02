"""Constants for the Scheduler integration."""
from __future__ import annotations

from homeassistant.const import Platform

DOMAIN = "hassio_scheduler"
NAME = "Scheduler"
VERSION = "1.0.0"

PLATFORMS = [Platform.SENSOR, Platform.SWITCH]

# Storage
STORAGE_VERSION = 1
STORAGE_KEY_SCHEDULES = f"{DOMAIN}.schedules"

# Panel
PANEL_URL_PATH = DOMAIN
PANEL_TITLE = "Scheduler"
PANEL_ICON = "mdi:calendar-clock"
PANEL_NAME = "hassio-scheduler-panel"
FRONTEND_SCRIPT_URL = f"/hassio_scheduler_panel/{PANEL_NAME}.js"

# Dispatcher signals
SIGNAL_SCHEDULES_UPDATED = f"{DOMAIN}_schedules_updated"

# Events fired on the HA event bus
EVENT_TRIGGERED = f"{DOMAIN}_triggered"
EVENT_SKIPPED = f"{DOMAIN}_skipped"
EVENT_UPDATED = f"{DOMAIN}_updated"

# Services
SERVICE_RUN_NOW = "run_now"
SERVICE_ENABLE = "enable"
SERVICE_DISABLE = "disable"
SERVICE_REMOVE_SCHEDULE = "remove_schedule"

ATTR_SCHEDULE_ID = "schedule_id"
ATTR_TIMESLOT_ID = "timeslot_id"

WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

# How many days ahead to search when pre-computing the "next run" value
# shown on sensors / the frontend. Firing itself does not depend on this.
NEXT_RUN_HORIZON_DAYS = 14

CONF_SCHEDULES = "schedules"
