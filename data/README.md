# Data sources

This folder records the agreements that the project uses, where they come
from, and their licenses.

- `manifest.csv`: one row for each source.
- `ATTRIBUTION.md`: the credit that each license requires.
- `private/`: files that you must not commit. Git ignores this folder.

## 1. Purpose

Agreements are the input to Agent 1. Each agreement has gold rules. A gold
rule is the correct answer for one term, for example the amount of
milestone 2. The tests compare the system output with the gold rules.

The data does not depend on the model. If the team changes the model, the
agreements and gold rules stay the same.

## 2. Sources in use

| Source | License as stated | Status |
| --- | --- | --- |
| [Common Paper Professional Services Agreement 1.1](https://github.com/CommonPaper/PSA/blob/0c3f3647790c33efb839bf1f701e8ef8d1c92235/psa.md) | CC BY 4.0 | Retrieved |
| [Common Paper Statement of Work](https://commonpaper.com/standards/statement-of-work/) | CC BY 4.0 | To retrieve |
| [Bonterms Professional Services Agreement 1.2](https://bonterms.com/forms/) | CC BY 4.0 unless noted | To review |
| [Pelican Delivers software development agreement](https://www.sec.gov/Archives/edgar/data/1802830/000166225220000006/ex10_3.htm) (SEC EDGAR) | Copyright unclear | Candidate |
| [Talyxor website development agreement](https://www.sec.gov/Archives/edgar/data/2150122/000215012226000004/ex10_2.htm) (SEC EDGAR) | Copyright unclear | Candidate |

Common Paper is the base text. Team variants add the milestones and amounts.
The two SEC filings are real contracts. The team uses them to calibrate the
gold rules.

## 3. Sources to add

- 6 to 10 more services contracts from
  [EDGAR full-text search](https://www.sec.gov/edgar/search/).
- [CUAD](https://www.atticusprojectai.org/cuad), to find services contracts.
- [FAR 32.10](https://www.acquisition.gov/far/subpart-32.10), for payment and
  refund terms. US federal text has no US copyright.

The team does not use public Solidity datasets now. No dataset pairs English
milestone agreements with single-file Solidity 0.8.28 escrow contracts.

## 4. Rules

1. Add a row to `manifest.csv` before you use a source.
2. Write the license as the source states it.
3. Do not commit the full text of an SEC filing. Commit the link and the gold
   rules. Keep the full text in `private/`.
4. Replace names and bank details with fictional values. The Pelican filing
   has bank details in plain text.
5. Obey the
   [SEC access rules](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data):
   at most 10 requests each second, with a User-Agent that identifies you.

## 5. Open item

The schema sets `refundPolicy` to `none` and `deadline` to `null`. Refund and
deadline terms cannot enter the pipeline until the team agrees on
interface v2.
