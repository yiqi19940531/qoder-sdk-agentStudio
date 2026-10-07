"""Text-to-image HTTP entrypoint. Input/output are one JSON object on stdin/stdout."""
import json
import os
import sys
import urllib.error
import urllib.request


def main():
    request = json.load(sys.stdin)
    body = {
        "model": request["model"],
        "input": {"messages": [{"role": "user", "content": [{"text": request["prompt"]}]}]},
        "parameters": {"size": request["size"], "n": 1, "watermark": False, "prompt_extend": True},
    }
    url = os.environ["BAILIAN_API_BASE"].rstrip("/") + "/services/aigc/multimodal-generation/generation"
    http_request = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + os.environ["DASHSCOPE_API_KEY"], "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(http_request, timeout=300) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        try:
            details = json.load(error)
        except Exception:
            details = {}
        raise RuntimeError(f"HTTP {error.code}: {details.get('code', 'ProviderError')} {details.get('message', '')[:300]}") from None
    content = result["output"]["choices"][0]["message"]["content"]
    image = next(item["image"] for item in content if "image" in item)
    print(json.dumps({"url": image, "requestId": result.get("request_id", "")}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)[:400]}), flush=True)
        sys.exit(1)
