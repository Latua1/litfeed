"""litfeed — a configurable PubMed monitoring feed with keyboard-driven triage.

The package holds the library code; the runnable entry points are the scripts
in the repository root:

    setup_wizard.py          write config.yaml by answering questions
    generate_feed.py         build docs/feed.json (the article feed)
    fetch_toc.py             build docs/toc.json (journal tables of contents)
    fetch_pdfs.py            download open-access full text for kept articles
    build_library_index.py   badge articles whose full text you already hold
"""

__version__ = "1.0.0"
