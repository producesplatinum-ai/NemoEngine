# Reading Nemo Engine 11.5.2 through the GitHub connector

The current connector-readable entry point is:

`Nemo Engine/Connector Readable/11.5.2 General RP/README.md`

The original `Nemo Engine 11.5.2 - General RP.json` remains unchanged and authoritative. The readable mirror splits it into valid JSON files no larger than 48 KiB and includes a deterministic reassembler that verifies byte-for-byte equality with the original.

In code mode, a chat can alternatively fetch Git blob `dec71df412a9b2189aec271d1428d0728dde6e3c` and parse its full `result.content` inside the tool call. It should not print the entire payload into one model response and should not substitute the older 11.3 prompt archive.
