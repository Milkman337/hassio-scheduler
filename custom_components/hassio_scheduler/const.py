"""Constants for the Scheduler integration."""
from __future__ import annotations

from homeassistant.const import Platform

DOMAIN = "hassio_scheduler"
NAME = "Scheduler"
VERSION = "1.2.0"

PLATFORMS = [Platform.SENSOR, Platform.SWITCH]

# Storage
STORAGE_VERSION = 1
STORAGE_KEY_SCHEDULES = f"{DOMAIN}.schedules"
STORAGE_KEY_HEATING = f"{DOMAIN}.heating_programs"
STORAGE_KEY_GLOBAL = f"{DOMAIN}.global_state"

# Panel
PANEL_URL_PATH = DOMAIN
PANEL_TITLE = "Scheduler"
PANEL_ICON = "mdi:calendar-clock"
PANEL_NAME = "hassio-scheduler-panel"
FRONTEND_SCRIPT_URL = f"/hassio_scheduler_panel/{PANEL_NAME}.js"

# Dispatcher signals
SIGNAL_SCHEDULES_UPDATED = f"{DOMAIN}_schedules_updated"
SIGNAL_HEATING_UPDATED = f"{DOMAIN}_heating_updated"
SIGNAL_GLOBAL_UPDATED = f"{DOMAIN}_global_updated"

# Events fired on the HA event bus
EVENT_TRIGGERED = f"{DOMAIN}_triggered"
EVENT_SKIPPED = f"{DOMAIN}_skipped"
EVENT_UPDATED = f"{DOMAIN}_updated"
EVENT_HEATING_APPLIED = f"{DOMAIN}_heating_applied"

# Services
SERVICE_RUN_NOW = "run_now"
SERVICE_ENABLE = "enable"
SERVICE_DISABLE = "disable"
SERVICE_REMOVE_SCHEDULE = "remove_schedule"
SERVICE_HEATING_BOOST = "heating_boost"
SERVICE_HEATING_SET_OVERRIDE = "heating_set_override"
SERVICE_HEATING_CLEAR_OVERRIDE = "heating_clear_override"
SERVICE_PAUSE = "pause"
SERVICE_RESUME = "resume"

ATTR_SCHEDULE_ID = "schedule_id"
ATTR_TIMESLOT_ID = "timeslot_id"
ATTR_PROGRAM_ID = "program_id"

WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

# How many days ahead to search when pre-computing the "next run" value
# shown on sensors / the frontend. Firing itself does not depend on this.
NEXT_RUN_HORIZON_DAYS = 14

CONF_SCHEDULES = "schedules"

# Heating
HEATING_SLOT_MINUTES = 30
DEFAULT_HEATING_PRESETS = [
    {"id": "frost", "name": "Frost protection", "temperature": 7, "color": "#4fc3f7", "icon": "mdi:snowflake"},
    {"id": "eco", "name": "Eco", "temperature": 17, "color": "#81c784", "icon": "mdi:leaf"},
    {"id": "comfort", "name": "Comfort", "temperature": 21, "color": "#ffb74d", "icon": "mdi:sofa"},
    {"id": "boost", "name": "Boost", "temperature": 23, "color": "#e57373", "icon": "mdi:fire"},
]
