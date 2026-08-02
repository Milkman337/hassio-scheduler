"""Sensor entities for Scheduler.

One sensor is created per user-defined schedule (state = next run time), plus
a single overview sensor showing the soonest upcoming event across all
schedules, and one sensor per heating program (state = its currently
resolved target temperature). Entities are added/removed dynamically as
schedules/programs are created or deleted through the panel.
"""
from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import UnitOfTemperature
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity
import homeassistant.util.dt as dt_util

from .const import DOMAIN, NAME
from .coordinator import SchedulerCoordinator
from .heating_coordinator import HeatingCoordinator


def _device_info() -> DeviceInfo:
    return DeviceInfo(
        identifiers={(DOMAIN, DOMAIN)},
        name=NAME,
        manufacturer="hassio-scheduler",
        model="Scheduler",
        entry_type=DeviceEntryType.SERVICE,
    )


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator: SchedulerCoordinator = hass.data[DOMAIN]["coordinator"]

    overview = SchedulerOverviewSensor(coordinator)
    async_add_entities([overview])

    known_ids: set[str] = set()
    entities: dict[str, ScheduleSensor] = {}

    @callback
    def _sync() -> None:
        current_ids = set(coordinator.data or {})
        new_ids = current_ids - known_ids
        removed_ids = known_ids - current_ids

        if new_ids:
            new_entities = [ScheduleSensor(coordinator, schedule_id) for schedule_id in new_ids]
            for entity in new_entities:
                entities[entity.schedule_id] = entity
            async_add_entities(new_entities)
            known_ids.update(new_ids)

        for schedule_id in removed_ids:
            entity = entities.pop(schedule_id, None)
            if entity is not None:
                hass.async_create_task(entity.async_remove())
            known_ids.discard(schedule_id)

    _sync()
    coordinator.async_add_listener(_sync)

    heating_coordinator: HeatingCoordinator = hass.data[DOMAIN]["heating_coordinator"]
    known_heating_ids: set[str] = set()
    heating_entities: dict[str, HeatingProgramSensor] = {}

    @callback
    def _sync_heating() -> None:
        current_ids = set(heating_coordinator.data or {})
        new_ids = current_ids - known_heating_ids
        removed_ids = known_heating_ids - current_ids

        if new_ids:
            new_entities = [HeatingProgramSensor(heating_coordinator, program_id) for program_id in new_ids]
            for entity in new_entities:
                heating_entities[entity.program_id] = entity
            async_add_entities(new_entities)
            known_heating_ids.update(new_ids)

        for program_id in removed_ids:
            entity = heating_entities.pop(program_id, None)
            if entity is not None:
                hass.async_create_task(entity.async_remove())
            known_heating_ids.discard(program_id)

    _sync_heating()
    heating_coordinator.async_add_listener(_sync_heating)


class ScheduleSensor(CoordinatorEntity[SchedulerCoordinator], SensorEntity):
    """Represents a single schedule's next run time."""

    _attr_has_entity_name = True
    _attr_device_class = SensorDeviceClass.TIMESTAMP
    _attr_icon = "mdi:calendar-clock"

    def __init__(self, coordinator: SchedulerCoordinator, schedule_id: str) -> None:
        super().__init__(coordinator)
        self.schedule_id = schedule_id
        self._attr_unique_id = f"{DOMAIN}_{schedule_id}_next_run"
        self._attr_device_info = _device_info()

    @property
    def _entry(self) -> dict[str, Any]:
        return (self.coordinator.data or {}).get(self.schedule_id, {})

    @property
    def available(self) -> bool:
        return bool(self._entry)

    @property
    def name(self) -> str:
        schedule = self._entry.get("schedule", {})
        return schedule.get("name", "Schedule")

    @property
    def icon(self) -> str:
        schedule = self._entry.get("schedule", {})
        return schedule.get("icon") or "mdi:calendar-clock"

    @property
    def native_value(self) -> Any:
        next_run = self._entry.get("next_run")
        return dt_util.parse_datetime(next_run) if next_run else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        schedule = self._entry.get("schedule", {})
        return {
            "enabled": schedule.get("enabled", False),
            "timeslot_count": len(schedule.get("timeslots", [])),
            "last_triggered": self._entry.get("last_triggered"),
            "color": schedule.get("color"),
        }


class SchedulerOverviewSensor(CoordinatorEntity[SchedulerCoordinator], SensorEntity):
    """Shows the soonest upcoming event across every enabled schedule."""

    _attr_has_entity_name = True
    _attr_name = "Next scheduled event"
    _attr_device_class = SensorDeviceClass.TIMESTAMP
    _attr_icon = "mdi:calendar-star"

    def __init__(self, coordinator: SchedulerCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{DOMAIN}_next_event"
        self._attr_device_info = _device_info()

    def _soonest(self) -> tuple[str | None, dict[str, Any] | None]:
        best_id: str | None = None
        best_entry: dict[str, Any] | None = None
        best_dt = None
        for schedule_id, entry in (self.coordinator.data or {}).items():
            next_run = entry.get("next_run")
            if not next_run:
                continue
            parsed = dt_util.parse_datetime(next_run)
            if parsed is None:
                continue
            if best_dt is None or parsed < best_dt:
                best_id, best_entry, best_dt = schedule_id, entry, parsed
        return best_id, best_entry

    @property
    def native_value(self) -> Any:
        _, entry = self._soonest()
        if not entry or not entry.get("next_run"):
            return None
        return dt_util.parse_datetime(entry["next_run"])

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        schedule_id, entry = self._soonest()
        if not entry:
            return {}
        schedule = entry.get("schedule", {})
        return {
            "schedule_id": schedule_id,
            "schedule_name": schedule.get("name"),
        }


class HeatingProgramSensor(CoordinatorEntity[HeatingCoordinator], SensorEntity):
    """Represents a heating program's currently resolved target temperature."""

    _attr_has_entity_name = True
    _attr_device_class = SensorDeviceClass.TEMPERATURE
    _attr_native_unit_of_measurement = UnitOfTemperature.CELSIUS
    _attr_icon = "mdi:radiator"

    def __init__(self, coordinator: HeatingCoordinator, program_id: str) -> None:
        super().__init__(coordinator)
        self.program_id = program_id
        self._attr_unique_id = f"{DOMAIN}_heating_{program_id}_target"
        self._attr_device_info = _device_info()

    @property
    def _entry(self) -> dict[str, Any]:
        return (self.coordinator.data or {}).get(self.program_id, {})

    @property
    def available(self) -> bool:
        return bool(self._entry)

    @property
    def name(self) -> str:
        program = self._entry.get("program", {})
        return program.get("name", "Heating program")

    @property
    def icon(self) -> str:
        program = self._entry.get("program", {})
        return program.get("icon") or "mdi:radiator"

    @property
    def native_value(self) -> Any:
        return self._entry.get("target_temperature")

    @property
    def native_unit_of_measurement(self) -> str:
        units = getattr(self.hass.config, "units", None)
        return getattr(units, "temperature_unit", UnitOfTemperature.CELSIUS)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        program = self._entry.get("program", {})
        override = program.get("override")
        return {
            "enabled": program.get("enabled", False),
            "source": self._entry.get("source"),
            "climate_entities": program.get("climate_entities", []),
            "override_active": bool(override),
            "override_until": (override or {}).get("until"),
            "color": program.get("color"),
        }
