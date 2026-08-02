"""Switch entities - one per schedule, to enable/disable it."""
from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN, NAME
from .coordinator import SchedulerCoordinator
from .heating_coordinator import HeatingCoordinator
from .heating_store import HeatingStore
from .store import ScheduleStore


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
    store: ScheduleStore = hass.data[DOMAIN]["store"]

    known_ids: set[str] = set()
    entities: dict[str, ScheduleSwitch] = {}

    @callback
    def _sync() -> None:
        current_ids = set(coordinator.data or {})
        new_ids = current_ids - known_ids
        removed_ids = known_ids - current_ids

        if new_ids:
            new_entities = [ScheduleSwitch(coordinator, store, schedule_id) for schedule_id in new_ids]
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
    heating_store: HeatingStore = hass.data[DOMAIN]["heating_store"]
    known_heating_ids: set[str] = set()
    heating_entities: dict[str, HeatingProgramSwitch] = {}

    @callback
    def _sync_heating() -> None:
        current_ids = set(heating_coordinator.data or {})
        new_ids = current_ids - known_heating_ids
        removed_ids = known_heating_ids - current_ids

        if new_ids:
            new_entities = [
                HeatingProgramSwitch(heating_coordinator, heating_store, program_id) for program_id in new_ids
            ]
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


class ScheduleSwitch(CoordinatorEntity[SchedulerCoordinator], SwitchEntity):
    """Enable/disable a single schedule."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:calendar-check"

    def __init__(self, coordinator: SchedulerCoordinator, store: ScheduleStore, schedule_id: str) -> None:
        super().__init__(coordinator)
        self.schedule_id = schedule_id
        self._store = store
        self._attr_unique_id = f"{DOMAIN}_{schedule_id}_enabled"
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
        return schedule.get("icon") or "mdi:calendar-check"

    @property
    def is_on(self) -> bool:
        schedule = self._entry.get("schedule", {})
        return bool(schedule.get("enabled"))

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self._store.async_set_enabled(self.schedule_id, True)
        await self.coordinator.async_request_refresh()

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._store.async_set_enabled(self.schedule_id, False)
        await self.coordinator.async_request_refresh()


class HeatingProgramSwitch(CoordinatorEntity[HeatingCoordinator], SwitchEntity):
    """Enable/disable a single heating program."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:radiator"

    def __init__(self, coordinator: HeatingCoordinator, store: HeatingStore, program_id: str) -> None:
        super().__init__(coordinator)
        self.program_id = program_id
        self._store = store
        self._attr_unique_id = f"{DOMAIN}_heating_{program_id}_enabled"
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
    def is_on(self) -> bool:
        program = self._entry.get("program", {})
        return bool(program.get("enabled"))

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self._store.async_set_enabled(self.program_id, True)
        await self.coordinator.async_request_refresh()

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._store.async_set_enabled(self.program_id, False)
        await self.coordinator.async_request_refresh()
