"""Text-to-video submit/poll HTTP entrypoint. Input/output use JSON stdin/stdout."""
import json
import os
import sys
import urllib.error
import urllib.request


def call(url, method, body=None):
    headers = {"Authorization": "Bearer " + os.environ["DASHSCOPE_API_KEY"], "Content-Type": "application/json"}
    if method == "POST":
        headers["X-DashScope-Async"] = "enable"
    request = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        try:
            details = json.load(error)
        except Exception:
            details = {}
        raise RuntimeError(f"HTTP {error.code}: {details.get('code', 'ProviderError')} {details.get('message', '')[:300]}") from None


def main():
    request = json.load(sys.stdin)
    base = os.environ["BAILIAN_API_BASE"].rstrip("/")
    if request["action"] == "submit":
        body = {
            "model": request["model"],
            "input": {"prompt": request["prompt"]},
            "parameters": {
                "resolution": request["resolution"], "ratio": "16:9",
                "duration": request["duration"], "prompt_extend": True, "watermark": False,
            },
        }
        result = call(base + "/services/aigc/video-generation/video-synthesis", "POST", body)
        print(json.dumps({"taskId": result["output"]["task_id"], "status": result["output"]["task_status"], "requestId": result.get("request_id", "")}), flush=True)
    elif request["action"] == "poll":
        result = call(base + "/tasks/" + request["taskId"], "GET")
        output = result["output"]
        print(json.dumps({"taskId": request["taskId"], "status": output["task_status"], "url": output.get("video_url"), "requestId": result.get("request_id", ""), "code": output.get("code"), "message": output.get("message")}), flush=True)
    else:
        raise ValueError("Unsupported action")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)[:400]}), flush=True)
        sys.exit(1)
