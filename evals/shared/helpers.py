"""
Helper functions and data classes for Claude Code skill evaluations.
"""

import csv
import json
import os
import re
import subprocess
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional


@dataclass
class TestCase:
    """Represents a single test case from a prompts CSV."""
    id: str
    should_trigger: bool
    prompt: str
    expected_skill: str
    notes: str = ""


@dataclass
class ClaudeOutput:
    """Parsed output from `claude -p --output-format=json`."""
    type: str = ""
    subtype: str = ""
    is_error: bool = False
    result: str = ""
    session_id: str = ""
    duration_ms: int = 0
    duration_api_ms: int = 0
    num_turns: int = 0
    total_cost_usd: float = 0.0
    usage: dict = field(default_factory=dict)
    raw: dict = field(default_factory=dict)

    @classmethod
    def from_json(cls, data: dict) -> "ClaudeOutput":
        """Create ClaudeOutput from parsed JSON."""
        return cls(
            type=data.get("type", ""),
            subtype=data.get("subtype", ""),
            is_error=data.get("is_error", False),
            result=data.get("result", ""),
            session_id=data.get("session_id", ""),
            duration_ms=data.get("duration_ms", 0),
            duration_api_ms=data.get("duration_api_ms", 0),
            num_turns=data.get("num_turns", 0),
            total_cost_usd=data.get("total_cost_usd", 0.0),
            usage=data.get("usage", {}),
            raw=data,
        )


@dataclass
class TestResult:
    """Result of running a single test."""
    id: str
    status: str  # "pass", "fail", "error", "timeout"
    duration: float = 0.0
    exit_code: int = 0
    should_trigger: bool = False
    skill_triggered: bool = False
    expected_skill: str = ""
    error: str = ""
    output: Optional[ClaudeOutput] = None

    def to_dict(self, include_response: bool = False) -> dict:
        """Convert to dictionary for JSON serialization."""
        result = {
            "id": self.id,
            "status": self.status,
            "duration": self.duration,
            "exit_code": self.exit_code,
            "should_trigger": self.should_trigger,
            "skill_triggered": self.skill_triggered,
            "expected_skill": self.expected_skill,
            "error": self.error,
        }

        if include_response and self.output:
            result["response"] = {
                "result": self.output.result,
                "duration_ms": self.output.duration_ms,
                "duration_api_ms": self.output.duration_api_ms,
                "num_turns": self.output.num_turns,
                "total_cost_usd": self.output.total_cost_usd,
                "usage": self.output.usage,
                "session_id": self.output.session_id,
                "is_error": self.output.is_error,
                "subtype": self.output.subtype,
            }

        return result


@dataclass
class GradeResult:
    """Result of grading a test."""
    overall_pass: bool
    score: int
    checks: list = field(default_factory=list)
    deterministic: dict = field(default_factory=dict)
    model_assisted: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "overall_pass": self.overall_pass,
            "score": self.score,
            "checks": self.checks,
            "deterministic": self.deterministic,
            "model_assisted": self.model_assisted,
        }


def load_prompts(csv_path: str) -> list[TestCase]:
    """Load test cases from a prompts CSV file."""
    tests = []
    with open(csv_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            tests.append(TestCase(
                id=row["id"],
                should_trigger=row["should_trigger"].lower() == "true",
                prompt=row["prompt"],
                expected_skill=row["expected_skill"],
                notes=row.get("notes", ""),
            ))
    return tests


def run_claude(
    prompt: str,
    work_dir: str,
    timeout: int = 300,
) -> tuple[Optional[ClaudeOutput], int, float]:
    """
    Run Claude in detached mode with JSON output.

    Args:
        prompt: The prompt to send to Claude
        work_dir: Working directory for the command
        timeout: Timeout in seconds

    Returns:
        Tuple of (ClaudeOutput or None, exit_code, duration_seconds)
    """
    os.makedirs(work_dir, exist_ok=True)

    start_time = time.time()

    try:
        result = subprocess.run(
            ["claude", "-p", "--output-format=json", prompt],
            cwd=work_dir,
            capture_output=True,
            text=True,
            timeout=timeout,
        )

        duration = time.time() - start_time

        if result.stdout:
            try:
                data = json.loads(result.stdout)
                return ClaudeOutput.from_json(data), result.returncode, duration
            except json.JSONDecodeError:
                return ClaudeOutput(result=result.stdout), result.returncode, duration

        return None, result.returncode, duration

    except subprocess.TimeoutExpired:
        duration = time.time() - start_time
        return None, -1, duration


def test_skill_triggered(output: Optional[ClaudeOutput], expected_skill: str) -> bool:
    """Check if the expected skill was triggered based on Claude's output."""
    if not output or not output.result:
        return False

    result = output.result.lower()
    skill = expected_skill.lower().replace("-", "[-_]?")

    # Check for skill invocation patterns
    patterns = [
        rf"/{expected_skill.lower()}",
        rf"skill.*{skill}",
        rf"invoking.*{skill}",
        rf"running.*{skill}",
        rf"using.*{skill}.*skill",
        rf"{skill}.*skill",
        rf"execute.*{skill}",
    ]

    for pattern in patterns:
        if re.search(pattern, result):
            return True

    return False


def test_plan_mode_used(output: Optional[ClaudeOutput]) -> bool:
    """Check if plan mode was entered."""
    if not output or not output.result:
        return False

    result = output.result.lower()
    patterns = ["enterplanmode", "entering plan mode", "plan mode", "/plan"]

    return any(p in result for p in patterns)


def get_metrics(output: Optional[ClaudeOutput]) -> dict:
    """Extract metrics from Claude's output."""
    if not output:
        return {}

    return {
        "duration_ms": output.duration_ms,
        "duration_api_ms": output.duration_api_ms,
        "num_turns": output.num_turns,
        "total_cost_usd": output.total_cost_usd,
        "is_error": output.is_error,
        "subtype": output.subtype,
        "input_tokens": output.usage.get("input_tokens", 0),
        "output_tokens": output.usage.get("output_tokens", 0),
        "cache_read_tokens": output.usage.get("cache_read_input_tokens", 0),
        "cache_creation_tokens": output.usage.get("cache_creation_input_tokens", 0),
    }


def run_deterministic_checks(output: Optional[ClaudeOutput]) -> dict:
    """Run stage 1 deterministic checks."""
    checks = []

    # Check 1: Execution success
    exec_success = output is not None and not output.is_error and output.subtype == "success"
    checks.append({
        "id": "execution_success",
        "pass": exec_success,
        "notes": "Execution completed successfully" if exec_success else "Execution failed or errored",
    })

    # Check 2: Response generated
    has_response = output is not None and output.result and len(output.result) > 0
    response_len = len(output.result) if output and output.result else 0
    checks.append({
        "id": "response_generated",
        "pass": has_response,
        "notes": f"Response of {response_len} chars",
    })

    # Check 3: Reasonable token usage
    token_limit = 50000
    total_tokens = 0
    if output and output.usage:
        total_tokens = (
            output.usage.get("input_tokens", 0) +
            output.usage.get("output_tokens", 0) +
            output.usage.get("cache_creation_input_tokens", 0)
        )
    reasonable_tokens = total_tokens < token_limit
    checks.append({
        "id": "reasonable_tokens",
        "pass": reasonable_tokens,
        "notes": f"Used {total_tokens} tokens (limit: {token_limit})",
    })

    # Check 4: Reasonable turn count
    turn_limit = 20
    num_turns = output.num_turns if output else 0
    reasonable_turns = num_turns < turn_limit
    checks.append({
        "id": "reasonable_turns",
        "pass": reasonable_turns,
        "notes": f"Used {num_turns} turns (limit: {turn_limit})",
    })

    return {"checks": checks}


def save_json(data: Any, path: str) -> None:
    """Save data as JSON to a file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, default=str)


def load_json(path: str) -> dict:
    """Load JSON from a file."""
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def get_timestamp() -> str:
    """Get current timestamp string."""
    return datetime.now().strftime("%Y-%m-%d-%H%M%S")


def print_colored(text: str, color: str) -> None:
    """Print colored text to console."""
    colors = {
        "red": "\033[91m",
        "green": "\033[92m",
        "yellow": "\033[93m",
        "blue": "\033[94m",
        "magenta": "\033[95m",
        "cyan": "\033[96m",
        "white": "\033[97m",
        "gray": "\033[90m",
        "reset": "\033[0m",
    }
    print(f"{colors.get(color, '')}{text}{colors['reset']}")
