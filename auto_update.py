import json
import hashlib
from pathlib import Path
from typing import Dict, Any, Optional
from datetime import datetime
import sys
import os

# Import the scraper
from scrape_courses import MivaCourseScraper, logger


class AutoUpdateSystem:
    """Handles automated course database updates with change detection and changelog management."""

    def __init__(self, output_dir: Path = Path('.')):
        self.output_dir = Path(output_dir).resolve()
        self.output_dir.mkdir(exist_ok=True)

        self.full_data_file = self.output_dir / 'miva_courses_full.json'
        self.extension_file = self.output_dir / 'courses_database.json'
        self.hash_file = self.output_dir / '.courses_hash.txt'
        self.changelog_file = self.output_dir / 'CHANGELOG.md'

    def _load_json(self, file_path: Path) -> Dict[str, Any]:
        """Load JSON from file with error handling."""
        if not file_path.exists():
            logger.info(f"No previous data found at {file_path} (first run)")
            return {}
        try:
            with file_path.open('r', encoding='utf-8') as f:
                data = json.load(f)
            logger.info(f"Loaded previous course data from {file_path}")
            return data
        except (json.JSONDecodeError, IOError) as e:
            logger.warning(f"Failed to load {file_path}: {e}")
            return {}

    def _save_json(self, data: Dict[str, Any], file_path: Path) -> None:
        """Save dict to JSON file."""
        try:
            with file_path.open('w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
        except IOError as e:
            logger.error(f"Failed to save {file_path}: {e}")

    def _calculate_hash(self, data: Dict[str, Any]) -> str:
        """Calculate SHA-256 hash of *departments* only (stable part) for change detection."""
        stable_data = data.get('departments', {})  # Exclude volatile metadata
        json_str = json.dumps(stable_data, sort_keys=True)
        return hashlib.sha256(json_str.encode('utf-8')).hexdigest()

    def _load_hash(self) -> str:
        """Load previous data hash from file."""
        if self.hash_file.exists():
            hash_val = self.hash_file.read_text(encoding='utf-8').strip()
            logger.debug(f"Loaded hash from {self.hash_file}: {hash_val[:8]}...")
            return hash_val
        logger.info(f"No previous hash found at {self.hash_file}")
        return ""

    def _save_hash(self, hash_value: str) -> None:
        """Save hash to file."""
        self.hash_file.write_text(hash_value, encoding='utf-8')
        logger.info(f"Saved new hash to {self.hash_file}")

    def _detect_changes(self, old_data: Dict[str, Any], new_data: Dict[str, Any]) -> Dict[str, Any]:
        """Detect and summarize changes between old and new course data."""
        changes: Dict[str, Any] = {
            'new_departments': [],
            'modified_departments': [],
            'new_courses': 0,
            'modified_courses': 0,
        }

        old_depts = old_data.get('departments', {})
        new_depts = new_data.get('departments', {})

        # Handle first run: all new
        if not old_depts:
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

        # Modified departments and course counts
        for dept_code, new_dept in new_depts.items():
            if dept_code in old_depts:
                old_courses = old_depts[dept_code].get('courses', {})
                new_courses = new_dept.get('courses', {})

                # Structural change?
                if json.dumps(old_courses, sort_keys=True) != json.dumps(new_courses, sort_keys=True):
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
        if not any(changes.values()):
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
            entry += f"### New Courses Added: {changes['new_courses']}\n\n"

        if changes['modified_courses']:
            entry += f"### Courses Modified/Removed: {changes['modified_courses']}\n\n"

        # Append to existing or create new
        if self.changelog_file.exists():
            content = self.changelog_file.read_text(encoding='utf-8') + entry
        else:
            content = "# Course Database Changelog\n\n" + entry

        self.changelog_file.write_text(content, encoding='utf-8')
        logger.info(f"Changelog updated: {self.changelog_file}")

    def run_update(self) -> bool:
        """Execute the full update: scrape, save, detect changes, and log."""
        logger.info("Starting automated course database update...")

        # Load old data and hash upfront
        old_data = self._load_json(self.extension_file)
        old_hash = self._load_hash()

        # If old_data exists but no hash file, compute from old_data to avoid false positives
        if old_data and not self.hash_file.exists():
            old_hash = self._calculate_hash(old_data)
            logger.info("Computed old hash from existing data (missing hash file)")

        # Scrape fresh data
        scraper = MivaCourseScraper()
        scraper.scrape_all("https://miva.edu.ng")

        # Save new data
        scraper.save_to_json(str(self.full_data_file))
        scraper.save_extension_format(str(self.extension_file))

        # Load new data and compute hash
        new_data = self._load_json(self.extension_file)
        new_hash = self._calculate_hash(new_data)

        logger.info(f"Hash comparison - Old: {old_hash}... | New: {new_hash}...")

        # Check for changes (first run or actual diff)
        has_changes = bool(not old_data or old_hash != new_hash)
        if has_changes:
            logger.info("Data hash mismatch detected!")
            changes = self._detect_changes(old_data, new_data)
            self._update_changelog(changes)
            self._save_hash(new_hash)
        else:
            logger.info("No changes detected in course data")

        return has_changes


def main() -> int:
    """Main entry point: run update and handle GitHub Actions output."""
    try:
        updater = AutoUpdateSystem()
        has_changes = updater.run_update()

        # Output for GitHub Actions
        if 'GITHUB_OUTPUT' in os.environ:
            with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as f:
                f.write(f"has_changes={'true' if has_changes else 'false'}\n")

        logger.info("✓ Automated update completed successfully")
        return 0

    except Exception as e:
        logger.error(f"Automated update failed: {e}", exc_info=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())