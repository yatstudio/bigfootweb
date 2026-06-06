#!/usr/bin/env python3
"""Bigfoot Serenity scorecard.

Usage:
  python scripts/bigfoot_serenity_scorecard.py --template
  python scripts/bigfoot_serenity_scorecard.py scorecard.json --format md
  cat scorecard.json | python scripts/bigfoot_serenity_scorecard.py - --format both
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Dict, Tuple

POSITIVE_WEIGHTS = {
    "demand_inflection": 14,
    "scarce_layer_power": 16,
    "customer_urgency": 12,
    "evidence_quality": 15,
    "financial_or_protocol_capture": 13,
    "valuation_gap": 10,
    "catalyst_timing": 10,
    "tradability_liquidity": 10,
}

PENALTY_WEIGHTS = {
    "valuation_crowding": 2.0,
    "financing_dilution_unlock": 2.2,
    "governance_or_contract_risk": 2.4,
    "accounting_or_tokenomics_risk": 2.2,
    "geopolitical_policy_risk": 1.8,
    "liquidity_slippage_risk": 2.0,
    "hype_without_revenue": 2.4,
    "substitution_risk": 1.8,
}

TEMPLATE = {
    "ticker": "EXAMPLE",
    "company_or_token": "Example Co / Example Token",
    "market": "A-share/HK/US/Global/Crypto",
    "timeframe": "industry_3_12m/event_1_8w/trading_observation/early_onchain",
    "positive_factors": {key: 0 for key in POSITIVE_WEIGHTS},
    "penalties": {key: 0 for key in PENALTY_WEIGHTS},
    "evidence": [{"claim": "", "source": "", "strength": "strong/medium/weak/needs-checking"}],
    "kill_switches": ["", "", ""],
}


def _num_0_to_5(value: Any, label: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{label} must be a number from 0 to 5") from None
    if number < 0 or number > 5:
        raise ValueError(f"{label} must be from 0 to 5; got {number}")
    return number


def load_input(path: str) -> Dict[str, Any]:
    raw = sys.stdin.read() if path == "-" else open(path, "r", encoding="utf-8").read()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise SystemExit("Input JSON must be an object")
    return data


def score(data: Dict[str, Any]) -> Dict[str, Any]:
    positives = data.get("positive_factors", data.get("factors", {}))
    penalties = data.get("penalties", {})

    positive_total = 0.0
    positive_details: Dict[str, Dict[str, float]] = {}
    for key, weight in POSITIVE_WEIGHTS.items():
        rating = _num_0_to_5(positives.get(key, 0), f"positive_factors.{key}")
        points = rating / 5.0 * weight
        positive_details[key] = {"rating": rating, "weight": weight, "points": round(points, 2)}
        positive_total += points

    penalty_total = 0.0
    penalty_details: Dict[str, Dict[str, float]] = {}
    for key, multiplier in PENALTY_WEIGHTS.items():
        rating = _num_0_to_5(penalties.get(key, 0), f"penalties.{key}")
        points = rating * multiplier
        penalty_details[key] = {"rating": rating, "multiplier": multiplier, "points": round(points, 2)}
        penalty_total += points

    final_score = max(0.0, min(100.0, positive_total - penalty_total))

    if final_score >= 85:
        verdict = "Top priority / 优先深挖"
    elif final_score >= 70:
        verdict = "High priority / 高优先观察"
    elif final_score >= 55:
        verdict = "Watchlist / 观察名单"
    else:
        verdict = "Lead only / 线索或低优先级"

    return {
        "ticker": data.get("ticker", ""),
        "company_or_token": data.get("company_or_token", data.get("company", "")),
        "market": data.get("market", ""),
        "timeframe": data.get("timeframe", ""),
        "positive_points": round(positive_total, 2),
        "penalty_points": round(penalty_total, 2),
        "final_score": round(final_score, 2),
        "verdict": verdict,
        "positive_details": positive_details,
        "penalty_details": penalty_details,
        "evidence": data.get("evidence", []),
        "kill_switches": data.get("kill_switches", data.get("what_could_weaken_view", [])),
    }


def to_markdown(result: Dict[str, Any]) -> str:
    title = result.get("ticker") or "Unknown"
    name = result.get("company_or_token")
    if name:
        title = f"{title} ({name})"

    lines = [
        f"# Bigfoot Serenity Scorecard: {title}",
        "",
        f"Market: {result.get('market', '')}",
        f"Timeframe: {result.get('timeframe', '')}",
        f"Final score: **{result['final_score']} / 100**",
        f"Verdict: **{result['verdict']}**",
        f"Positive points: {result['positive_points']}",
        f"Penalty points: {result['penalty_points']}",
        "",
        "## Positive factors",
        "| Factor | Rating | Weight | Points |",
        "|---|---:|---:|---:|",
    ]
    for key, detail in result["positive_details"].items():
        lines.append(f"| {key} | {detail['rating']} | {detail['weight']} | {detail['points']} |")

    lines.extend(["", "## Penalties", "| Penalty | Rating | Multiplier | Points |", "|---|---:|---:|---:|"])
    for key, detail in result["penalty_details"].items():
        lines.append(f"| {key} | {detail['rating']} | {detail['multiplier']} | {detail['points']} |")

    evidence_lines = []
    for ev in result.get("evidence", []):
        if isinstance(ev, dict):
            claim = str(ev.get("claim", "")).strip()
            source = str(ev.get("source", "")).strip()
            strength = str(ev.get("strength", "")).strip()
            if claim or source:
                evidence_lines.append(f"- [{strength}] {claim} — {source}")
    if evidence_lines:
        lines.extend(["", "## Evidence"])
        lines.extend(evidence_lines)

    kill_switches = [str(x).strip() for x in result.get("kill_switches", []) if str(x).strip()]
    if kill_switches:
        lines.extend(["", "## Kill switches / 降级条件"])
        lines.extend([f"- {x}" for x in kill_switches])

    lines.append("\n注：评分用于研究优先级，不是买卖指令。")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Score a Bigfoot Serenity investment candidate")
    parser.add_argument("input", nargs="?", help="JSON scorecard file, or '-' for stdin")
    parser.add_argument("--template", action="store_true", help="Print a JSON template")
    parser.add_argument("--format", choices=["json", "md", "both"], default="json")
    args = parser.parse_args()

    if args.template:
        print(json.dumps(TEMPLATE, ensure_ascii=False, indent=2))
        return
    if not args.input:
        parser.error("input is required unless --template is used")

    result = score(load_input(args.input))
    if args.format == "json":
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif args.format == "md":
        print(to_markdown(result))
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        print("\n---\n")
        print(to_markdown(result))


if __name__ == "__main__":
    main()
