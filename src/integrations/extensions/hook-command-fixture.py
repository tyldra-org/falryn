"""Protocol-only fixture: EOF-delimited input, one correlated JSON response."""
import json
import sys

request = json.load(sys.stdin)
assert request["version"] == 1
assert request["envelope"]["point"] == "before-capability-invocation"
assert request["envelope"]["registrationGeneration"] == 7
json.dump({"version": 1, "invocationId": request["invocationId"], "decision": {"kind": "observe", "annotations": {"fixture": "reviewed"}}}, sys.stdout, separators=(",", ":"))
