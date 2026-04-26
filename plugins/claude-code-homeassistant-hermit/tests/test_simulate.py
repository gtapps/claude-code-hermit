from ha_agent_lab.simulate import simulate_artifact
from helpers import write_artifact

ARTIFACT_YAML = """
alias: Test
actions:
  - service: light.turn_on
    target:
      entity_id: light.kitchen_counter
  - service: cover.open_cover
    target:
      entity_id: cover.garage_door
""".strip()


def test_simulation_reports_missing_and_sensitive_entities(make_ha_root) -> None:
    root = make_ha_root(inventory={
        "entity_index": {
            "light.kitchen_counter": {"entity_id": "light.kitchen_counter", "state": "off"},
        }
    })
    artifact = write_artifact(root, ARTIFACT_YAML, name="artifact.yaml")

    result = simulate_artifact(root, artifact)

    assert not result.is_valid
    assert "cover.garage_door" in result.missing_entities
    assert any("cover.garage_door" in reason for reason in result.blocked_reasons)
