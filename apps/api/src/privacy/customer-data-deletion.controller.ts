import { BadRequestException, Controller, Delete, HttpCode, HttpStatus, Param } from '@nestjs/common';
import type { CustomerDataDeletionResult } from '@ai-customer-service/contracts';
import { CurrentWorkspace } from '../auth/current-workspace.decorator';
import type { AuthenticatedWorkspace } from '../workspaces/workspace.repository';
import { CustomerDataDeletionService } from './customer-data-deletion.service';

/** The global API prefix supplies `/api`; this controller owns `/buyers/...`. */
@Controller('buyers')
export class CustomerDataDeletionController {
  constructor(private readonly deletion: CustomerDataDeletionService) {}

  @Delete(':buyerId/customer-data')
  @HttpCode(HttpStatus.OK)
  async remove(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Param('buyerId') buyerId: string,
  ): Promise<CustomerDataDeletionResult> {
    const id = buyerId?.trim();
    if (!id) {
      throw new BadRequestException({
        code: 'CUSTOMER_DATA_SUBJECT_INVALID',
        message: 'buyerId is required',
      });
    }
    return this.deletion.deleteCustomerData(scope, id);
  }
}
