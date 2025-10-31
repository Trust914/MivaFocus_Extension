"""
MIVA Course Scraper - Automated Update System
=============================================
Handles automated course database updates with change detection and changelog management.
"""

import json
import hashlib
from pathlib import Path
from typing import Dict, Any, Optional
from datetime import datetime
import sys
import os

# Import settings and scraper
import settings
from scrape_courses import MivaCourseScraper, logger


class AutoUpdateSystem:
    """Handles automated course database updates with change detection and changelog management."""

    def __init__(self, output_dir: Optional[Path] = None):

        self.output_dir = output_dir or settings.OUTPUT_DIR
        self.output_dir.mkdir(parents=True, exist_ok=True)

        self.full_data_file = settings.FULL_DATA_FILE
        self.changelog_file = settings.CHANGELOG_FILE

    def _load_json(self, file_path: Path) -> Dict[str, Any]:
        """Load JSON from file with error handling."""
        if not file_path.exists():
            logger.info(f"No previous data found at {file_path} (first run)")
            return {}
        try:
            with file_path.open('r', encoding=settings.LOG_ENCODING) as f:
                data = json.load(f)
            logger.info(f"Loaded previous course data from {file_path}")
            return data
        except (json.JSONDecodeError, IOError) as e:
            logger.warning(f"Failed to load {file_path}: {e}")
            return {}

    def _save_json(self, data: Dict[str, Any], file_path: Path) -> None:
        """Save dict to JSON file."""
        try:
            with file_path.open('w', encoding=settings.LOG_ENCODING) as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            logger.info(f"Saved data to {file_path}")
        except IOError as e:
            logger.error(f"Failed to save {file_path}: {e}")

    def _calculate_hash(self, data: Dict[str, Any]) -> str:
        """Calculate SHA-256 hash of *faculties* only (stable part) for change detection."""
        # Hashes the 'faculties' key from the full data structure
        stable_data = data.get('faculties', {})  # Exclude volatile metadata
        json_str = json.dumps(stable_data, sort_keys=True)
        return hashlib.sha256(json_str.encode(settings.LOG_ENCODING)).hexdigest()

    def _get_flat_depts(self, full_data: Dict[str, Any]) -> Dict[str, Any]:
        """Extracts a flat department dictionary for comparison."""
        flat_depts = {}
        for faculty_data in full_data.get('faculties', {}).values():
            for dept_code, dept_data in faculty_data.get('departments', {}).items():
                # We only need the part used for comparison: name and courses
                flat_depts[dept_code] = {
                    'name': dept_data.get('name'),
                    'courses': dept_data.get('courses', {})
                }
        return flat_depts

    def _detect_changes(self, old_data: Dict[str, Any], new_data: Dict[str, Any]) -> Dict[str, Any]:
        """Detect and summarize changes between old and new course data."""
        changes: Dict[str, Any] = {
            'new_departments': [],
            'modified_departments': [],
            'new_courses': 0,
            'modified_courses': 0,  # Tracks removals or modifications
        }

        # Use the helper to get the comparable part from the full data
        old_depts = self._get_flat_depts(old_data)
        new_depts = self._get_flat_depts(new_data)

        # Handle first run: all new
        if not old_depts:
            if settings.CREATE_INITIAL_CHANGELOG:
                changes['new_departments'] = list(new_depts.keys())
                changes['new_courses'] = sum(
                    sum(len(sem) for sem in level.values())
                    for dept in new_depts.values()
                    for level in dept.get('courses', {}).values()
                )
            return changes

        # New departments
        for dept_code in new_depts:
            if dept_code not in old_depts:
                changes['new_departments'].append(dept_code)
                # Count all courses in new dept as new
                new_dept_courses = new_depts[dept_code].get('courses', {})
                changes['new_courses'] += sum(
                    len(sem) for level in new_dept_courses.values() for sem in level.values()
                )

        # Modified departments
        for dept_code, new_dept in new_depts.items():
            if dept_code in old_depts and dept_code not in changes['new_departments']:
                old_courses = old_depts[dept_code].get('courses', {})
                new_courses = new_dept.get('courses', {})

                # Use hash for quick check
                old_courses_hash = json.dumps(old_courses, sort_keys=True)
                new_courses_hash = json.dumps(new_courses, sort_keys=True)
                
                if old_courses_hash != new_courses_hash:
                    changes['modified_departments'].append(dept_code)

                    # Approximate count diff (additions/removals)
                    old_count = sum(len(sem) for level in old_courses.values() for sem in level.values())
                    new_count = sum(len(sem) for level in new_courses.values() for sem in level.values())
                    diff = new_count - old_count
                    
                    if diff > 0:
                        changes['new_courses'] += diff
                    elif diff < 0:
                        changes['modified_courses'] += abs(diff)

        return changes

    def _update_changelog(self, changes: Dict[str, Any]) -> None:
        """Append change summary to changelog file."""
        if not any(v for k, v in changes.items() if k != 'modified_courses' and v) and not changes['modified_courses']:
            logger.info("No structural changes detected - changelog not updated")
            return

        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        entry = f"\n## Update - {timestamp}\n\n"

        if changes['new_departments']:
            entry += f"### New Departments ({len(changes['new_departments'])})\n"
            for dept in changes['new_departments']:
                entry += f"- {dept}\n"
            entry += "\n"

        if changes['modified_departments']:
            entry += f"### Modified Departments ({len(changes['modified_departments'])})\n"
            for dept in changes['modified_departments']:
                entry += f"- {dept}\n"
            entry += "\n"

        if changes['new_courses']:
            entry += f"### New Courses Added (Approx.): {changes['new_courses']}\n\n"

        if changes['modified_courses']:
            entry += f"### Courses Modified/Removed (Approx.): {changes['modified_courses']}\n\n"

        # Append to existing file or create new
        if self.changelog_file.exists():
            content = self.changelog_file.read_text(encoding=settings.LOG_ENCODING)
            # Find the first H2 to insert after the H1
            first_h2 = content.find('\n## ')
            if first_h2 != -1:
                content = content[:first_h2] + entry + content[first_h2:]
            else:
                content += entry  # Fallback, append
        else:
            content = "# Course Database Changelog\n" + entry

        self.changelog_file.write_text(content, encoding=settings.LOG_ENCODING)
        logger.info(f"Changelog updated: {self.changelog_file}")

    def run_update(self) -> bool:
        """Execute the full update: scrape, detect changes in-memory, and save if needed."""
        logger.info("Starting automated course database update...")

        # Load old data from the full data file
        old_data = self._load_json(self.full_data_file)
        
        # Get the old hash *from the data itself*
        # Defaults to "" if not found (first run)
        old_hash = old_data.get('metadata', {}).get('content_hash', '')

        # 1. Scrape fresh data (in memory)
        try:
            scraper = MivaCourseScraper()
            new_full_data = scraper.scrape_all()
        except ImportError as e:
            if 'lxml' in str(e) and settings.PARSER == 'lxml':
                logger.warning("`lxml` not found, falling back to 'html.parser'.")
                logger.warning("Run `pip install lxml` for better performance.")
                scraper = MivaCourseScraper(parser='html.parser')
                new_full_data = scraper.scrape_all()
            else:
                raise
        except Exception as e:
            logger.error(f"Scraping failed: {e}", exc_info=True)
            return False 

        if not new_full_data.get('faculties'):
            logger.error("Scraping returned no data. Aborting update.")
            return False        
        # 3. Compute new hash (in memory) from the full data
        new_hash = self._calculate_hash(new_full_data)

        logger.info(f"Hash comparison - Old: {old_hash[:8]}... | New: {new_hash[:8]}...")

        # 4. Check for changes
        has_changes = bool(not old_data or old_hash != new_hash)
        
        if has_changes:
            logger.info("Data hash mismatch detected! Changes found.")
            # Detect changes between the full data structures
            changes = self._detect_changes(old_data, new_full_data)
            
            # 5. Save all files
            self._update_changelog(changes)
            
            # Add the new hash to the metadata before saving
            new_full_data.setdefault('metadata', {})['content_hash'] = new_hash
            
            # Save the updated full data
            self._save_json(new_full_data, self.full_data_file)
            # self._save_json(new_extension_data, self.extension_file) - REMOVED
        else:
            logger.info("No changes detected in course data. Files not updated.")
            
            # update full data file to refresh timestamp
            if settings.ALWAYS_SAVE_FULL_DATA:
                self._save_json(new_full_data, self.full_data_file)
                logger.info("Updated full data file timestamp (no course changes)")

        return has_changes


def main() -> int:
    """Main entry point: run update and handle GitHub Actions output."""
    try:
        # Log configuration
        logger.info("=" * 70)
        logger.info("MIVA COURSE DATABASE AUTO-UPDATE SYSTEM")
        logger.info("=" * 70)
        logger.info(f"Output Directory: {settings.OUTPUT_DIR}")
        logger.info(f"Parser: {settings.PARSER}")
        logger.info(f"Max Workers: {settings.MAX_WORKERS}")
        logger.info(f"Timeout: {settings.TIMEOUT}s")
        logger.info(f"GitHub Actions: {settings.IS_GITHUB_ACTIONS}")
        logger.info("=" * 70)
        
        updater = AutoUpdateSystem()
        has_changes = updater.run_update()

        # Output for GitHub Actions
        if settings.IS_GITHUB_ACTIONS and settings.GITHUB_OUTPUT_FILE:
            with open(settings.GITHUB_OUTPUT_FILE, 'a', encoding=settings.LOG_ENCODING) as f:
                f.write(f"has_changes={str(has_changes).lower()}\n")
            logger.info(f"GitHub Actions output written: has_changes={has_changes}")

        logger.info(f"✓ Automated update completed. Changes detected: {has_changes}")
        return 0

    except Exception as e:
        logger.error(f"Automated update failed: {e}", exc_info=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
