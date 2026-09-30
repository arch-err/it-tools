import { parse as parseToml } from 'smol-toml';
import { isNotThrowing } from '../../utils/boolean';

export { isValidToml };

function isValidToml(toml: string): boolean {
  return isNotThrowing(() => parseToml(toml));
}
