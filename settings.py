import os
from pathlib import Path
from typing import Dict

# ============================================================================
# BASE CONFIGURATION
# ============================================================================

BASE_URL =  'https://miva.edu.ng'
FACULTIES_URL =  'https://miva.edu.ng'

# ============================================================================
# SCRAPING CONFIGURATION
# ============================================================================

# Request timeout in seconds
TIMEOUT = 15

# Maximum concurrent threads for scraping
MAX_WORKERS =  5

# HTML Parser: 'lxml' (faster) or 'html.parser' (built-in)
PARSER = 'lxml'

# User agent for requests
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'


# Retry configuration
MAX_RETRIES =  3
RETRY_DELAY =  2  # seconds

# ============================================================================
# OUTPUT CONFIGURATION
# ============================================================================

# Output directory for all generated files
OUTPUT_DIR = Path('.').resolve()

# Output file names
FULL_DATA_FILENAME = 'miva_courses_full.json'
EXTENSION_FILENAME = 'courses_database.json'
HASH_FILENAME =  '.courses_hash.txt'
CHANGELOG_FILENAME = 'CHANGELOG.md'

# Computed full paths
FULL_DATA_FILE = OUTPUT_DIR / FULL_DATA_FILENAME 
EXTENSION_FILE = OUTPUT_DIR / EXTENSION_FILENAME
HASH_FILE = OUTPUT_DIR / HASH_FILENAME
CHANGELOG_FILE = OUTPUT_DIR / CHANGELOG_FILENAME

# ============================================================================
# LOGGING CONFIGURATION
# ============================================================================

# Log file configuration
LOG_FILE =  'scraper.log'
LOG_LEVEL = 'INFO'  # DEBUG, INFO, WARNING, ERROR
LOG_FORMAT = '%(asctime)s - %(levelname)s - %(message)s'
LOG_ENCODING = 'utf-8'

# ============================================================================
# METADATA CONFIGURATION
# ============================================================================

METADATA = {
    'version': '1.0.0',
    'academicYear': '2024/2025',
    'source': BASE_URL,
    'scraper': 'MivaFocus Course Scraper'
}

# ============================================================================
# DEPARTMENT CODE MAPPINGS
# ============================================================================

DEPARTMENT_CODES: Dict[str, str] = {
    # School of Computing
    'computer science': 'CSC',
    'cybersecurity': 'CYB',
    'data science': 'DTS',
    'information technology': 'IFT',
    'software engineering': 'SEN',
    
    # School of Management and Social Sciences
    'business management': 'BUA',
    'economics': 'ECO',
    'accounting': 'ACC',
    'public policy and administration': 'PPA',
    'entrepreneurship': 'ENT',
    
    # School of Communication and Media Studies
    'criminology and security studies': 'CRS',
    'mass communication': 'MAC',
    'communication and media studies': 'MAC',
    
    # School of Allied Health Sciences
    'nursing science': 'NUR',
    'public health': 'PHH',
}

# ============================================================================
# CHANGE DETECTION CONFIGURATION
# ============================================================================

# Whether to create changelog entries for first run
CREATE_INITIAL_CHANGELOG = True

# Whether to save files even when no changes detected (updates timestamp)
ALWAYS_SAVE_FULL_DATA = True

# ============================================================================
# GITHUB ACTIONS CONFIGURATION
# ============================================================================

# Whether running in GitHub Actions
IS_GITHUB_ACTIONS = 'GITHUB_OUTPUT' in os.environ

# GitHub output file path (if running in Actions)
GITHUB_OUTPUT_FILE = os.getenv('GITHUB_OUTPUT', None)

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def ensure_output_directory():
    """Ensure output directory exists"""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def validate_config():
    """Validate configuration and return any errors"""
    errors = []
    
    # Validate MAX_WORKERS
    if MAX_WORKERS < 1:
        errors.append(f"MAX_WORKERS must be >= 1, got {MAX_WORKERS}")
    
    # Validate TIMEOUT
    if TIMEOUT < 1:
        errors.append(f"TIMEOUT must be >= 1, got {TIMEOUT}")
    
    # Validate PARSER
    if PARSER not in ['lxml', 'html.parser']:
        errors.append(f"PARSER must be 'lxml' or 'html.parser', got '{PARSER}'")
    
    # Validate LOG_LEVEL
    valid_levels = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL']
    if LOG_LEVEL.upper() not in valid_levels:
        errors.append(f"LOG_LEVEL must be one of {valid_levels}, got '{LOG_LEVEL}'")
    
    return errors

# ============================================================================
# INITIALIZATION
# ============================================================================

# Ensure output directory exists on import
ensure_output_directory()

# Validate configuration
config_errors = validate_config()
if config_errors:
    import sys
    print("Configuration errors found:", file=sys.stderr)
    for error in config_errors:
        print(f"  - {error}", file=sys.stderr)
    sys.exit(1)