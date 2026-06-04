import urllib.request

try:
    url = "http://localhost:8001/metrics"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req) as response:
        content = response.read().decode('utf-8')
        
    print("=== METRICS ===")
    lines = content.split('\n')
    for line in lines:
        if "emitted" in line or "dropped" in line or "error" in line or "events" in line or "batch" in line:
            print(line)
except Exception as e:
    print("Error:", e)
