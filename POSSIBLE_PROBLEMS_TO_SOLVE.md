# Possible Problems to Solve

- **Tacit knowledge in expense allocations:** The fund manager must personally reconcile expenses and allocate them across the management company, the fund, and the portfolio companies. This manual intervention is necessary because the manager is "generally the only person who knows what every meeting was for". Automating this workflow requires inferring subjective, unrecorded human context that is entirely absent from the raw financial data.

- **Scaling to massive context windows:** The manager notes that their current fund "fits in a human context window, let alone a model context window" because it consists of only thirty investors with mostly identical terms. This indicates that intaking and processing data for much larger funds—which may contain hundreds of complex, bespoke side letters—could easily overwhelm an AI model's context limitations.

- **Bridging the trust gap:** Because human administrators consistently make errors, the fund manager runs their output through a custom AI tool to generate a "forty-point memo" of corrections. The manager questions whether they need to build software specifically to check their administrator's work. Even if a platform successfully generates the Net Asset Value (NAV), convincing users to trust the automated output without feeling forced to run their own parallel verification tools remains a significant psychological and operational hurdle.

- **Cross-administrator data consolidation:** Finance teams struggle enormously to manually consolidate reporting data across as many as fifteen different fund administrators. Normalizing unstructured, disparate data formats from multiple external organizations into a single, cohesive system poses a severe data engineering challenge.

- **Navigating bundled framework agreements:** Prospective clients often have all their administrative services "bundled into the framework agreement" with their existing provider. Convincing clients to run a new, automated platform alongside an incumbent vendor while these overarching, multi-service contracts are still in place presents a structural commercial challenge.
