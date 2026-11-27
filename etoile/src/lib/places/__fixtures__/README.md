Real responses from Open-Meteo's geocoding service, captured 2026-11-26 for
`research/live-data.md` section 2 and copied here unchanged so the tests do not
depend on the network.

| File | Request |
| --- | --- |
| `open-meteo-geocoding-lisbon.json` | `/v1/search?name=Lisbon&count=5&language=en&format=json` |
| `open-meteo-geocoding-springfield-us.json` | `/v1/search?name=Springfield&count=5&language=en&format=json&countryCode=US` |
| `open-meteo-geocoding-qualifier-springfield-il.json` | `/v1/search?name=Springfield%2C%20IL&count=3&language=en&format=json` |
| `open-meteo-geocoding-postal-60601.json` | `/v1/search?name=60601&count=3&countryCode=US` |
| `open-meteo-geocoding-empty.json` | `/v1/search?name=zzzzqqqxj&count=5&language=en&format=json` (no match: HTTP 200 with no `results` key) |

Location data based on GeoNames (CC BY 4.0), via Open-Meteo.
