import {
  Body,
  Controller,
  Get,
  Module,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RoleCode, Roles } from '../common/auth.js';
import { BranchesService } from './branches.service.js';
import { CreateBranchDto, UpdateBranchDto } from './dto/branch.dto.js';

@ApiTags('Branches')
@ApiBearerAuth()
@Controller('branches')
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  /** Branches with their batch and staff counts. Inactive branches only with includeInactive=true. */
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @ApiQuery({ name: 'includeInactive', required: false, type: Boolean })
  @Get()
  list(
    @Query('includeInactive', new ParseBoolPipe({ optional: true }))
    includeInactive?: boolean,
  ) {
    return this.branches.list(includeInactive ?? false);
  }

  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.branches.findOne(BigInt(id));
  }

  @Roles(RoleCode.ADMIN)
  @Post()
  create(@Body() dto: CreateBranchDto) {
    return this.branches.create(dto);
  }

  /** Branches are never deleted (batches, invoices and payments point at them); set isActive=false instead. */
  @Roles(RoleCode.ADMIN)
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateBranchDto) {
    return this.branches.update(BigInt(id), dto);
  }
}

@Module({
  controllers: [BranchesController],
  providers: [BranchesService],
  exports: [BranchesService],
})
export class BranchesModule {}
