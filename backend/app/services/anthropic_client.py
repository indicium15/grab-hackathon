import json

import httpx

from app.config import settings


class AnthropicClient:
    async def generate_rationales(
        self, user_profile: dict, neighbourhood_name: str, stops: list[dict]
    ) -> list[str]:
        if not settings.anthropic_api_key:
            raise RuntimeError("ANTHROPIC_API_KEY is missing.")

        prompt = self._build_prompt(user_profile, neighbourhood_name, stops)
        payload = {
            "model": "claude-sonnet-4-20250514",
            "max_tokens": 360,
            "temperature": 0.7,
            "messages": [{"role": "user", "content": prompt}],
        }
        headers = {
            "x-api-key": settings.anthropic_api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }

        async with httpx.AsyncClient(timeout=25.0) as client:
            response = await client.post(
                f"{settings.anthropic_base_url.rstrip('/')}/messages",
                json=payload,
                headers=headers,
            )
            response.raise_for_status()
            data = response.json()

        response_text = self._extract_message_text(data)
        parsed = self._parse_json(response_text)
        rationales = parsed.get("rationales", [])
        if isinstance(rationales, list):
            return [str(item) for item in rationales]
        return []

    def _build_prompt(self, user_profile: dict, neighbourhood_name: str, stops: list[dict]) -> str:
        stop_lines = "\n".join(
            f"{idx + 1}. {stop['name']} ({stop['business_type']})"
            for idx, stop in enumerate(stops)
        )
        return f"""
You are a witty city discovery guide for Singapore.

User profile:
- Usually eats: {", ".join(user_profile["preferredCuisines"])}
- Frequents: {", ".join(user_profile["frequentNeighbourhoods"])}

They've never explored {neighbourhood_name}. Here are their stops today:
{stop_lines}

For each stop, write ONE punchy sentence (max 15 words) explaining why this is a great stretch from their comfort zone. Be specific, warm, and slightly cheeky. Do not use generic phrases like "you'll love it" or "a must-try".

Respond as JSON: {{ "rationales": ["...", "...", "..."] }}
""".strip()

    def _extract_message_text(self, payload: dict) -> str:
        content = payload.get("content", [])
        text_chunks = [
            chunk.get("text", "")
            for chunk in content
            if isinstance(chunk, dict) and chunk.get("type") == "text"
        ]
        return "\n".join(text_chunks).strip()

    def _parse_json(self, text: str) -> dict:
        if not text:
            return {}

        stripped = text.strip()
        if stripped.startswith("```"):
            stripped = stripped.strip("`")
            if stripped.startswith("json"):
                stripped = stripped[4:].strip()
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            return {}
