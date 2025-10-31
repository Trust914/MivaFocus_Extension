import os
from pathlib import Path
from typing import Dict
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# ============================================================================
# HELPER FUNCTIONS FOR ENV VARIABLES
# ============================================================================

def get_env_bool(key: str) -> bool:
    """Get boolean from environment variable (required)"""
    value = os.getenv(key)
    if value is None:
        raise ValueError(f"Required environment variable '{key}' is not set")
    return value.lower() in ('true', '1', 'yes', 'on')

def get_env_int(key: str) -> int:
    """Get integer from environment variable (required)"""
    value = os.getenv(key)
    if value is None:
        raise ValueError(f"Required environment variable '{key}' is not set")
    try:
        return int(value)
    except (ValueError, TypeError) as e:
        raise ValueError(f"Invalid integer value for '{key}': {value}") from e

def get_env_str(key: str) -> str:
    """Get string from environment variable (required)"""
    value = os.getenv(key)
    if value is None:
        raise ValueError(f"Required environment variable '{key}' is not set")
    return value

# ============================================================================
# BASE CONFIGURATION
# ============================================================================

BASE_URL = get_env_str('BASE_URL')
FACULTIES_URL = get_env_str('FACULTIES_URL')

# ============================================================================
# SCRAPING CONFIGURATION
# ============================================================================

# Request timeout in seconds
TIMEOUT = get_env_int('TIMEOUT')

# Maximum concurrent threads for scraping
MAX_WORKERS = get_env_int('MAX_WORKERS')

# HTML Parser: 'lxml' (faster) or 'html.parser' (built-in)
PARSER = get_env_str('PARSER')

# User agent for requests
USER_AGENT = get_env_str('USER_AGENT')

# Retry configuration
MAX_RETRIES = get_env_int('MAX_RETRIES')
RETRY_DELAY = get_env_int('RETRY_DELAY')  # seconds

# ============================================================================
# OUTPUT CONFIGURATION
# ============================================================================

# Output directory for all generated files
OUTPUT_DIR = Path(get_env_str('OUTPUT_DIR')).resolve()

# Output file names
FULL_DATA_FILENAME = get_env_str('FULL_DATA_FILENAME')
# EXTENSION_FILENAME = get_env_str('EXTENSION_FILENAME')
CHANGELOG_FILENAME = get_env_str('CHANGELOG_FILENAME')

# Computed full paths
FULL_DATA_FILE = OUTPUT_DIR / FULL_DATA_FILENAME 
# EXTENSION_FILE = OUTPUT_DIR / EXTENSION_FILENAME
CHANGELOG_FILE = OUTPUT_DIR / CHANGELOG_FILENAME

# ============================================================================
# LOGGING CONFIGURATION
# ============================================================================

# Log file configuration
LOG_FILE = get_env_str('LOG_FILE')
LOG_LEVEL = get_env_str('LOG_LEVEL')  # DEBUG, INFO, WARNING, ERROR
LOG_FORMAT = get_env_str('LOG_FORMAT')
LOG_ENCODING = get_env_str('LOG_ENCODING')

# ============================================================================
# METADATA CONFIGURATION
# ============================================================================

METADATA = {
    'version': get_env_str('METADATA_VERSION'),
    'academicYear': get_env_str('METADATA_ACADEMIC_YEAR'),
    'source': BASE_URL,
    'scraper': get_env_str('METADATA_SCRAPER')
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
CREATE_INITIAL_CHANGELOG = get_env_bool('CREATE_INITIAL_CHANGELOG')

# Whether to save files even when no changes detected (updates timestamp)
ALWAYS_SAVE_FULL_DATA = get_env_bool('ALWAYS_SAVE_FULL_DATA')

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

try:
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
        
except ValueError as e:
    import sys
    print(f"Configuration error: {e}", file=sys.stderr)
    print("\nMake sure you have a .env file with all required variables.", file=sys.stderr)
    print("See .env.example for reference.", file=sys.stderr)
    sys.exit(1)
