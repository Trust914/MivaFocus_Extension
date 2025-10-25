"""
Automated Course Database Update System
Runs periodically via GitHub Actions to keep course data updated
"""

import json
import hashlib
from pathlib import Path
from datetime import datetime
import sys
import os

# Import the scraper
from scrape_courses import MivaCourseScraper, logger


class AutoUpdateSystem:
    """Handles automated course database updates"""
    
    def __init__(self, output_dir: Path = Path('.')):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(exist_ok=True)
        
        self.full_data_file = self.output_dir / 'miva_courses_full.json'
        self.extension_file = self.output_dir / 'courses_database.json'
        self.hash_file = self.output_dir / '.courses_hash.txt'
        self.changelog_file = self.output_dir / 'CHANGELOG.md'
    
    def calculate_hash(self, data: dict) -> str:
        """Calculate hash of course data for change detection"""
        json_str = json.dumps(data, sort_keys=True)
        return hashlib.sha256(json_str.encode()).hexdigest()
    
    def load_previous_hash(self) -> str:
        """Load previous data hash"""
        if self.hash_file.exists():
            return self.hash_file.read_text().strip()
        return ""
    
    def save_hash(self, new_hash: str):
        """Save current data hash"""
        self.hash_file.write_text(new_hash)
    
    def detect_changes(self, old_data: dict, new_data: dict) -> dict:
        """Detect changes between old and new course data"""
        changes = {
            'new_departments': [],
            'modified_departments': [],
            'new_courses': 0,
            'modified_courses': 0
        }
        
        if not old_data or 'departments' not in old_data:
            changes['new_departments'] = list(new_data.get('departments', {}).keys())
            changes['new_courses'] = sum(
                sum(len(sem) for sem in level.values())
                for dept in new_data.get('departments', {}).values()
                for level in dept.get('courses', {}).values()
            )
            return changes
        
        old_depts = old_data.get('departments', {})
        new_depts = new_data.get('departments', {})
        
        # Find new departments
        for dept_code in new_depts:
            if dept_code not in old_depts:
                changes['new_departments'].append(dept_code)
        
        # Find modified departments and courses
        for dept_code, new_dept_data in new_depts.items():
            if dept_code in old_depts:
                old_courses = old_depts[dept_code].get('courses', {})
                new_courses = new_dept_data.get('courses', {})
                
                # Compare course structures
                if json.dumps(old_courses, sort_keys=True) != json.dumps(new_courses, sort_keys=True):
                    changes['modified_departments'].append(dept_code)
                    
                    # Count course differences
                    old_count = sum(
                        len(sem) for level in old_courses.values() for sem in level.values()
                    )
                    new_count = sum(
                        len(sem) for level in new_courses.values() for sem in level.values()
                    )
                    
                    if new_count > old_count:
                        changes['new_courses'] += (new_count - old_count)
                    elif new_count < old_count:
                        changes['modified_courses'] += abs(new_count - old_count)
        
        return changes
    
    def update_changelog(self, changes: dict):
        """Update changelog with detected changes"""
        if not any([changes['new_departments'], changes['modified_departments'], 
                   changes['new_courses'], changes['modified_courses']]):
            logger.info("No changes detected - changelog not updated")
            return
        
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        
        changelog_entry = f"\n## Update - {timestamp}\n\n"
        
        if changes['new_departments']:
            changelog_entry += f"### New Departments ({len(changes['new_departments'])})\n"
            for dept in changes['new_departments']:
                changelog_entry += f"- {dept}\n"
            changelog_entry += "\n"
        
        if changes['modified_departments']:
            changelog_entry += f"### Modified Departments ({len(changes['modified_departments'])})\n"
            for dept in changes['modified_departments']:
                changelog_entry += f"- {dept}\n"
            changelog_entry += "\n"
        
        if changes['new_courses']:
            changelog_entry += f"### New Courses Added: {changes['new_courses']}\n\n"
        
        if changes['modified_courses']:
            changelog_entry += f"### Courses Modified: {changes['modified_courses']}\n\n"
        
        # Append to changelog
        if self.changelog_file.exists():
            existing = self.changelog_file.read_text()
            content = existing + changelog_entry
        else:
            content = "# Course Database Changelog\n" + changelog_entry
        
        self.changelog_file.write_text(content)
        logger.info(f"Changelog updated: {self.changelog_file}")
    
    def run_update(self) -> bool:
        """Run the update process"""
        logger.info("Starting automated course database update...")
        
        # Load old data for comparison
        old_data = {}
        if self.extension_file.exists():
            try:
                with open(self.extension_file, 'r', encoding='utf-8') as f:
                    old_data = json.load(f)
                logger.info("Loaded previous course data for comparison")
            except Exception as e:
                logger.warning(f"Could not load previous data: {e}")
        
        # Run scraper
        scraper = MivaCourseScraper()
        scraper.scrape_all("https://miva.edu.ng")
        
        # Save new data
        scraper.save_to_json(str(self.full_data_file))
        scraper.save_extension_format(str(self.extension_file))
        
        # Load new data
        with open(self.extension_file, 'r', encoding='utf-8') as f:
            new_data = json.load(f)
        
        # Calculate hashes
        new_hash = self.calculate_hash(new_data)
        old_hash = self.load_previous_hash()
        
        # Detect changes
        if new_hash != old_hash:
            logger.info("Changes detected in course data!")
            changes = self.detect_changes(old_data, new_data)
            self.update_changelog(changes)
            self.save_hash(new_hash)
            return True
        else:
            logger.info("No changes detected in course data")
            return False


def main():
    """Main entry point for automated updates"""
    try:
        updater = AutoUpdateSystem()
        has_changes = updater.run_update()
        
        # Set output for GitHub Actions
        if 'GITHUB_OUTPUT' in os.environ:
            with open(os.environ['GITHUB_OUTPUT'], 'a') as f:
                f.write(f"has_changes={'true' if has_changes else 'false'}\n")
        
        logger.info("✓ Automated update completed successfully")
        return 0
        
    except Exception as e:
        logger.error(f"Automated update failed: {e}", exc_info=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())